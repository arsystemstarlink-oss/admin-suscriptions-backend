import {
  BillingPeriod,
  BusinessError,
  Subscription,
  SubscriptionStatus,
  WhatsAppMessage,
} from '../domain/entities';
import { createId, normalizeDni } from '../domain/business-rules';
import {
  buildTemplateVariables,
  formatWhatsAppCurrency,
  formatWhatsAppDate,
  isLegacyTemplate,
  resolveActiveTemplateKey,
} from '../domain/whatsapp-templates';
import {
  clientRepository,
  organizationRepository,
  planRepository,
  subscriptionRepository,
  whatsappConversationRepository,
  whatsappMessageRepository,
} from './repositories';
import { resolveWhatsAppNotificationConfig, resolveWhatsAppTemplateMode } from './whatsapp-configuration';
import {
  assertPlatformQuotaAvailable,
  recordPlatformSend,
  toSendingOrganization,
} from './whatsapp-platform';
import { resolveTwilioCredentials, whatsappService } from './whatsapp-service';

export interface PaymentConfirmationInput {
  organizationId: string;
  subscriptionId: string;
  billingPeriod: BillingPeriod;
  /** Período que queda vigente después del pago; sin él, se usa el fin del período pagado. */
  currentPeriod?: BillingPeriod;
  previousStatus?: SubscriptionStatus;
  subscription?: Subscription;
}

/** `Activo`, `Reactivado` o `Con saldo pendiente`, como lo entiende el cliente. */
function resolveServiceStatus(
  previousStatus: SubscriptionStatus | undefined,
  subscription: Subscription | undefined
): string {
  if (subscription?.status === 'SUSPENDED') return 'Con saldo pendiente';
  if (previousStatus === 'SUSPENDED' && subscription?.status === 'ACTIVE') return 'Reactivado';
  return 'Activo';
}

/**
 * Avisa al cliente que su pago quedó registrado. Es best-effort: un fallo de Twilio, falta de
 * plantilla o cupo agotado se registra y se ignora, nunca hace fallar el pago.
 */
export async function sendPaymentConfirmation(input: PaymentConfirmationInput): Promise<void> {
  try {
    const organization = await organizationRepository.getById(input.organizationId);
    if (!organization) return;

    const sendingOrganization = await toSendingOrganization(organization);
    const config = resolveWhatsAppNotificationConfig(sendingOrganization);
    if (config.rules.paymentConfirmationEnabled === false) return;

    const subscription =
      input.subscription ??
      (await subscriptionRepository.getByIdScoped(input.subscriptionId, input.organizationId));
    if (!subscription) return;

    const client = await clientRepository.getByIdScoped(subscription.clientId, input.organizationId);
    if (!client?.phone) return;

    const hasClientDni = Boolean(normalizeDni(client.dni ?? '')) && Boolean(sendingOrganization.slug);
    const key = resolveActiveTemplateKey(config, 'paymentConfirmation', hasClientDni);
    if (!key) {
      console.log(
        `[WhatsApp] Sin plantilla de confirmación activa para ${input.organizationId}; no se avisa del pago ${input.billingPeriod.id}.`
      );
      return;
    }
    const contentSid = config.templates[key];
    if (!contentSid) return;
    if (!resolveTwilioCredentials(sendingOrganization)) return;

    // La confirmación sale fuera del scheduler: se comprueba el cupo sin propagar el error.
    assertPlatformQuotaAvailable(sendingOrganization);

    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);
    const recent = await whatsappMessageRepository
      .listOutboundSince({
        organizationId: input.organizationId,
        phones: [client.phone],
        since: startOfToday,
      })
      .catch(() => [] as WhatsAppMessage[]);
    const alreadyConfirmed = recent.some(
      (message) =>
        message.notificationType === 'paymentConfirmation' &&
        message.body.includes(input.billingPeriod.periodLabel)
    );
    if (alreadyConfirmed) {
      console.log(
        `[WhatsApp] La confirmación del período ${input.billingPeriod.periodLabel} ya se envió hoy a ${client.phone}.`
      );
      return;
    }

    const plan = await planRepository.getByIdScoped(subscription.planId, input.organizationId);
    const coveredUntil = input.currentPeriod?.endDate ?? input.billingPeriod.endDate;
    const legacy = isLegacyTemplate(key);
    const variables = buildTemplateVariables(
      key,
      {
        clientName: `${client.firstName} ${client.lastName}`.trim(),
        organizationName: sendingOrganization.name,
        amount: legacy
          ? String(input.billingPeriod.amount)
          : formatWhatsAppCurrency(input.billingPeriod.amount),
        periodLabel: input.billingPeriod.periodLabel,
        serviceCode: subscription.kitNumber,
        serviceStatus: resolveServiceStatus(input.previousStatus, subscription),
        coveredUntil: legacy
          ? coveredUntil.toISOString().split('T')[0]
          : formatWhatsAppDate(coveredUntil),
        planName: plan?.name,
        portalSlug: sendingOrganization.slug,
      },
      resolveWhatsAppTemplateMode(sendingOrganization, key)
    );

    const messageSid = await whatsappService.sendTemplate(
      { to: client.phone, templateName: contentSid, variables },
      sendingOrganization
    );

    const now = new Date();
    const message: WhatsAppMessage = {
      id: createId(),
      organizationId: input.organizationId,
      clientId: client.id,
      subscriptionId: subscription.id,
      notificationType: key,
      phone: client.phone,
      direction: 'OUTBOUND',
      messageSid,
      body: `[Template: ${contentSid}] Variables: ${JSON.stringify(variables)}`,
      templateName: contentSid,
      status: 'SENT',
      createdAt: now,
    };
    await whatsappMessageRepository.create(message);
    await whatsappConversationRepository
      .upsertFromMessage(message, input.organizationId)
      .catch((error) => {
        console.error('[WhatsApp] Error actualizando conversación de confirmación:', error);
      });
    await recordPlatformSend(sendingOrganization);
    await subscriptionRepository.updateLastNotification(subscription.id, input.organizationId, {
      type: key,
      status: 'SENT',
      attemptedAt: now.toISOString(),
      messageSid,
    });
  } catch (error) {
    const message =
      error instanceof BusinessError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(
      `[WhatsApp] No se pudo enviar la confirmación del pago ${input.billingPeriod.id}: ${message}`
    );
  }
}

import cron, { ScheduledTask } from 'node-cron';
import {
  billingPeriodRepository,
  subscriptionRepository,
  planRepository,
  schedulerConfigRepository,
  clientRepository,
  whatsappMessageRepository,
  organizationRepository,
  domainEventRepository,
} from '../infrastructure/repositories';
import { SubscriptionBusinessService } from '../domain/subscription-service';
import { isDateAfter, areSameDay, createId } from '../domain/business-rules';
import { whatsappService } from './whatsapp-service';
import { pushService } from './push-service';
import { WhatsAppMessage, DomainEventType } from '../domain/entities';

const businessService = new SubscriptionBusinessService();
const SCHEDULER_TIMEZONE = process.env.SCHEDULER_TIMEZONE || 'America/Caracas';

let currentTask: ScheduledTask | null = null;

function getNextRun(cronExpression: string, timezone: string): Date {
  const TimeMatcher = require('node-cron/src/time-matcher');
  const matcher = new TimeMatcher(cronExpression, timezone);
  const start = Math.ceil(Date.now() / 1000) * 1000;
  const maxMs = 7 * 24 * 60 * 60 * 1000;
  for (let t = start; t < start + maxMs; t += 1000) {
    const candidate = new Date(t);
    if (matcher.match(candidate)) return candidate;
  }
  return new Date(start);
}

async function recordDomainEvent(
  type: DomainEventType,
  organizationId: string,
  entity: string,
  entityId: string,
  payload?: Record<string, unknown>
): Promise<void> {
  try {
    await domainEventRepository.create({
      id: createId(),
      type,
      organizationId,
      entity,
      entityId,
      payload,
      createdAt: new Date(),
    });
  } catch (error) {
    console.error(`[DomainEvent] Error registrando ${type}:`, error);
  }
}

export async function runDailyJobForOrganization(organizationId: string): Promise<{
  overdue: number;
  generated: number;
  suspended: number;
  notifications: number;
}> {
  const now = new Date();
  console.log(`[Daily Job] Ejecutando revisión automática - org ${organizationId} - ${now.toISOString()}`);

  const allPeriods = await billingPeriodRepository.listByOrganization(organizationId);
  const subscriptions = await subscriptionRepository.listByOrganization(organizationId);
  const clients = await clientRepository.listByOrganization(organizationId);

  let overdueCount = 0;
  let generatedCount = 0;
  let suspendedCount = 0;
  let notificationCount = 0;

  const suspendedSubscriptionIds = new Set(
    subscriptions.filter((s) => s.status === 'SUSPENDED').map((s) => s.id)
  );

  const activationPeriodIds = new Set<string>();
  for (const sub of subscriptions) {
    if (!sub.activationDate) continue;
    for (const p of allPeriods) {
      if (p.subscriptionId === sub.id && areSameDay(p.startDate, sub.activationDate)) {
        activationPeriodIds.add(p.id);
      }
    }
  }

  const eligiblePeriods = allPeriods.filter(
    (p) => !suspendedSubscriptionIds.has(p.subscriptionId)
  );

  const updatedPeriods = businessService.markPendingPeriodsOverdue(eligiblePeriods, now, activationPeriodIds);

  for (const period of updatedPeriods) {
    const original = allPeriods.find((p) => p.id === period.id);
    if (original && original.status !== period.status) {
      await billingPeriodRepository.update(period);
      overdueCount++;
      await recordDomainEvent(
        'billing_period.overdue',
        organizationId,
        'billingPeriod',
        period.id,
        { subscriptionId: period.subscriptionId }
      );
    }
  }

  for (const subscription of subscriptions) {
    if (subscription.status === 'SUSPENDED') continue;

    const subscriptionPeriods = updatedPeriods
      .filter((p) => p.subscriptionId === subscription.id)
      .sort((a, b) => b.endDate.getTime() - a.endDate.getTime());

    const currentPeriod = subscriptionPeriods[0];
    if (!currentPeriod) continue;

    const updatedSubscription = businessService.evaluateSubscriptionStatus(
      subscription,
      subscriptionPeriods
    );

    if (updatedSubscription.status !== subscription.status) {
      await subscriptionRepository.update(updatedSubscription);
      if (updatedSubscription.status === 'SUSPENDED') {
        suspendedCount++;

        const client = clients.find((c) => c.id === subscription.clientId);
        if (client) {
          await sendWhatsAppNotification(client, subscription, currentPeriod, 'suspended-notice', organizationId);
          notificationCount++;
        }

        await recordDomainEvent(
          'subscription.suspended',
          organizationId,
          'subscription',
          subscription.id,
          { kitNumber: subscription.kitNumber }
        );
      }
    }

    const finalSubscription = updatedSubscription.status !== subscription.status
      ? updatedSubscription
      : subscription;

    if (finalSubscription.status === 'ACTIVE') {
      if (
        isDateAfter(now, currentPeriod.endDate) || areSameDay(now, currentPeriod.endDate)
      ) {
        try {
          const plan = await planRepository.getByIdScoped(subscription.planId, organizationId);
          if (!plan) continue;

          const nextPeriod = businessService.createNextBillingPeriod({
            currentPeriod,
            subscription,
            plan,
          });

          const scopedNextPeriod = { ...nextPeriod, organizationId };
          await billingPeriodRepository.create(scopedNextPeriod);
          generatedCount++;
          await recordDomainEvent(
            'billing_period.generated',
            organizationId,
            'billingPeriod',
            scopedNextPeriod.id,
            { subscriptionId: subscription.id }
          );
        } catch (error) {
          console.error(`[Daily Job] Error generando período para suscripción ${subscription.id}:`, error);
        }
      }

      if (currentPeriod.status === 'PENDING' || currentPeriod.status === 'PAID') {
        const endDateNormalized = new Date(Date.UTC(currentPeriod.endDate.getUTCFullYear(), currentPeriod.endDate.getUTCMonth(), currentPeriod.endDate.getUTCDate()));
        const nowNormalized = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const daysUntilDue = Math.round((endDateNormalized.getTime() - nowNormalized.getTime()) / (1000 * 60 * 60 * 24));
        const client = clients.find((c) => c.id === subscription.clientId);
        if (client) {
          if (daysUntilDue === 3) {
            await sendWhatsAppNotification(client, subscription, currentPeriod, 'reminder', organizationId);
            notificationCount++;
          } else if (daysUntilDue === 0) {
            await sendWhatsAppNotification(client, subscription, currentPeriod, 'suspension-warning', organizationId);
            notificationCount++;
          }
        }
      }
    }
  }

  await schedulerConfigRepository.updateConfig({ lastRun: now }, organizationId);

  if (overdueCount > 0 || suspendedCount > 0) {
    try {
      const summaryParts = [
        overdueCount > 0 ? `${overdueCount} período(s) vencido(s)` : null,
        suspendedCount > 0 ? `${suspendedCount} suscripción(es) suspendida(s)` : null,
      ].filter(Boolean);

      await pushService.sendBroadcastToOrganization({
        organizationId,
        title: 'Resumen diario',
        body: summaryParts.join(' · '),
        data: { url: '/dashboard' },
      });
      console.log(`[Daily Job] Push de resumen enviado a los admins de ${organizationId}.`);
    } catch (error) {
      console.error('[Daily Job] Error enviando push de resumen:', error);
    }
  }

  console.log(
    `[Daily Job] Completado (org ${organizationId}) - Períodos vencidos: ${overdueCount}, Períodos generados: ${generatedCount}, Suscripciones suspendidas: ${suspendedCount}, Notificaciones enviadas: ${notificationCount}`
  );

  return { overdue: overdueCount, generated: generatedCount, suspended: suspendedCount, notifications: notificationCount };
}

export async function runDailyJob(): Promise<void> {
  const organizations = await organizationRepository.list();
  for (const organization of organizations) {
    if (!organization.active) continue;
    try {
      await runDailyJobForOrganization(organization.id);
    } catch (error) {
      console.error(`[Daily Job] Error en organización ${organization.id}:`, error);
    }
  }
}

export async function runDailyJobForOrganizationIfEnabled(organizationId: string): Promise<void> {
  const config = await schedulerConfigRepository.getConfig(organizationId);
  if (config.enabled) {
    await runDailyJobForOrganization(organizationId);
  }
}

async function sendWhatsAppNotification(
  client: { id: string; firstName: string; lastName: string; phone: string },
  subscription: { kitNumber: string },
  period: { endDate: Date },
  type: 'reminder' | 'suspension-warning' | 'suspended-notice',
  organizationId: string
): Promise<void> {
  const templateMap: Record<string, string | undefined> = {
    'reminder': process.env.TWILIO_TEMPLATE_SUBSCRIPTION_REMINDER_3DAYS_2V,
    'suspension-warning': process.env.TWILIO_TEMPLATE_SUBSCRIPTION_CUTOFF_DAY_2V,
    'suspended-notice': process.env.TWILIO_TEMPLATE_SUBSCRIPTION_SUSPENDED_NOTICE_2V,
  };

  const templateName = templateMap[type];

  if (!templateName) {
    console.log(`[WhatsApp] Template no configurado para ${type}. Skipping.`);
    return;
  }

  const endDateStr = period.endDate.toISOString().split('T')[0];
  const clientFullName = `${client.firstName} ${client.lastName}`;

  let variables: Record<string, string>;
  if (type === 'suspended-notice') {
    variables = {
      '1': clientFullName,
      '2': subscription.kitNumber,
    };
  } else if (type === 'suspension-warning') {
    variables = {
      '1': clientFullName,
      '2': subscription.kitNumber,
      '3': endDateStr,
    };
  } else {
    variables = {
      '1': clientFullName,
      '2': endDateStr,
    };
  }

  try {
    const messageSid = await whatsappService.sendTemplate({
      to: client.phone,
      templateName,
      variables,
    });

    const whatsappMsg: WhatsAppMessage = {
      id: createId(),
      organizationId,
      clientId: client.id,
      phone: client.phone,
      direction: 'OUTBOUND',
      messageSid,
      body: `[Template: ${templateName}] Variables: ${JSON.stringify(variables)}`,
      templateName,
      status: 'SENT',
      createdAt: new Date(),
    };

    await whatsappMessageRepository.create(whatsappMsg);
    console.log(`[WhatsApp] Notificación ${type} enviada a ${clientFullName} (${client.phone})`);
  } catch (error) {
    console.error(`[WhatsApp] Error enviando notificación ${type} a ${clientFullName}:`, error);
  }
}

function stopCurrentTask(): void {
  if (currentTask) {
    currentTask.stop();
    currentTask = null;
    console.log('[Scheduler] Tarea anterior detenida.');
  }
}

export async function scheduleFromConfig(): Promise<void> {
  stopCurrentTask();

  const config = await schedulerConfigRepository.getConfig();

  if (!config.enabled) {
    console.log('[Scheduler] Daily Job desactivado por configuración.');
    return;
  }

  if (!cron.validate(config.cronSchedule)) {
    console.error(`[Scheduler] Cron inválido: ${config.cronSchedule}. Usando valor por defecto.`);
    config.cronSchedule = '0 0 * * *';
  }

  currentTask = cron.schedule(config.cronSchedule, async () => {
    try {
      await runDailyJob();
    } catch (error) {
      console.error('[Scheduler] Error en Daily Job:', error);
    }
  }, { timezone: SCHEDULER_TIMEZONE });

  console.log(
    `[Scheduler] Daily Job programado con cron: ${config.cronSchedule} (enabled: ${config.enabled}) ` +
    `en zona horaria: ${SCHEDULER_TIMEZONE}. Próxima ejecución: ${getNextRun(config.cronSchedule, SCHEDULER_TIMEZONE).toString()}`
  );
}

export async function reschedule(): Promise<void> {
  await scheduleFromConfig();
}

export async function startScheduler(): Promise<void> {
  await scheduleFromConfig();
}

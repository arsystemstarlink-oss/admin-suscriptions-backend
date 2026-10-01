import cron from 'node-cron';
import { randomUUID } from 'crypto';
import {
  billingPeriodRepository,
  subscriptionRepository,
  planRepository,
  schedulerConfigRepository,
  schedulerLogRepository,
  clientRepository,
  whatsappMessageRepository,
  whatsappConversationRepository,
  organizationRepository,
  domainEventRepository,
  jobLockRepository,
} from '../infrastructure/repositories';
import { SubscriptionBusinessService } from '../domain/subscription-service';
import { isDateAfter, areSameDay, createId } from '../domain/business-rules';
import { whatsappService, resolveTwilioCredentials, extractTwilioError } from './whatsapp-service';
import { pushService } from './push-service';
import { applyRadarToSubscription, hasRadarChanged } from './subscription-radar';
import { WhatsAppMessage, DomainEventType, Organization, SchedulerLog } from '../domain/entities';

const businessService = new SubscriptionBusinessService();
const JOB_LOCK_TTL_MS = 15 * 60 * 1000;
const INSTANCE_ID = randomUUID();
const NOTIFICATION_INTERVAL_MS = Number(process.env.TWILIO_NOTIFICATIONS_INTERVAL_MS || 1500);

const SCHEDULER_TIMEZONE = process.env.SCHEDULER_TIMEZONE || 'America/Caracas';
const scheduledTasks = new Map<string, cron.ScheduledTask>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const notificationRateLimiter = new Map<string, number>();

async function throttleByAccount(accountSid: string): Promise<void> {
  const last = notificationRateLimiter.get(accountSid) ?? 0;
  const elapsed = Date.now() - last;
  const wait = NOTIFICATION_INTERVAL_MS - elapsed;
  if (wait > 0) {
    await delay(wait);
  }
  notificationRateLimiter.set(accountSid, Date.now());
}

export interface NotificationFailure {
  type: 'reminder' | 'suspension-warning' | 'suspended-notice';
  clientName: string;
  phone: string;
  errorCode?: number;
  errorMessage: string;
}

export interface DailyJobResult {
  overdue: number;
  generated: number;
  suspended: number;
  notifications: number;
  errors: NotificationFailure[];
  skipped?: boolean;
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

export async function runDailyJobForOrganization(
  organizationId: string,
  triggeredBy: 'scheduled' | 'manual' = 'manual'
): Promise<DailyJobResult> {
  const lockAcquired = await jobLockRepository.acquire(organizationId, INSTANCE_ID, JOB_LOCK_TTL_MS);
  if (!lockAcquired) {
    console.log(`[Daily Job] Organización ${organizationId} ya está en ejecución (lock activo). Skipping.`);
    await recordSchedulerLog({
      organizationId,
      triggeredBy,
      startedAt: new Date(),
      finishedAt: new Date(),
      durationMs: 0,
      status: 'skipped',
      result: undefined,
    });
    return { overdue: 0, generated: 0, suspended: 0, notifications: 0, errors: [], skipped: true };
  }

  const startedAt = new Date();
  let result: Omit<DailyJobResult, 'skipped'> | undefined;
  let error: string | undefined;
  try {
    result = await runDailyJobForOrganizationUnlocked(organizationId);
    return { ...result, skipped: false };
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    const finishedAt = new Date();
    await recordSchedulerLog({
      organizationId,
      triggeredBy,
      startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      status: error ? 'error' : 'success',
      result,
      error,
    });
    await jobLockRepository.release(organizationId, INSTANCE_ID);
  }
}

interface SchedulerLogInput {
  organizationId: string;
  triggeredBy: 'scheduled' | 'manual';
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  status: 'success' | 'error' | 'skipped';
  result: Omit<DailyJobResult, 'skipped'> | undefined;
  error?: string;
}

async function recordSchedulerLog(input: SchedulerLogInput): Promise<void> {
  const log: SchedulerLog = {
    id: createId(),
    organizationId: input.organizationId,
    triggeredBy: input.triggeredBy,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: input.durationMs,
    status: input.status,
    overdue: input.result?.overdue ?? 0,
    generated: input.result?.generated ?? 0,
    suspended: input.result?.suspended ?? 0,
    notifications: input.result?.notifications ?? 0,
    notificationErrors: input.result?.errors?.length ?? 0,
    error: input.error,
  };
  try {
    await schedulerLogRepository.create(log);
  } catch (logError) {
    console.error(`[SchedulerLog] Error registrando log para org ${input.organizationId}:`, logError);
  }
}

async function runDailyJobForOrganizationUnlocked(organizationId: string): Promise<Omit<DailyJobResult, 'skipped'>> {
  const now = new Date();
  console.log(`[Daily Job] Ejecutando revisión automática - org ${organizationId} - ${now.toISOString()}`);

  const organization = await organizationRepository.getById(organizationId);
  const allPeriods = await billingPeriodRepository.listByOrganization(organizationId);
  const subscriptions = await subscriptionRepository.listByOrganization(organizationId);
  const clients = await clientRepository.listByOrganization(organizationId);
  const allPlans = await planRepository.listByOrganization(organizationId);

  const plansById = new Map(allPlans.map((plan) => [plan.id, plan]));
  const periodsBySubscriptionId = new Map<string, typeof allPeriods>();
  for (const period of allPeriods) {
    const list = periodsBySubscriptionId.get(period.subscriptionId) || [];
    list.push(period);
    periodsBySubscriptionId.set(period.subscriptionId, list);
  }

  let overdueCount = 0;
  let generatedCount = 0;
  let suspendedCount = 0;
  let notificationCount = 0;
  const notificationErrors: NotificationFailure[] = [];

  const suspendedSubscriptionIds = new Set(
    subscriptions.filter((s) => s.status === 'SUSPENDED').map((s) => s.id)
  );

  const activationPeriodIds = new Set<string>();
  for (const sub of subscriptions) {
    if (!sub.activationDate) continue;
    const subPeriods = periodsBySubscriptionId.get(sub.id) || [];
    for (const p of subPeriods) {
      if (areSameDay(p.startDate, sub.activationDate)) {
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

    const finalSubscription = applyRadarToSubscription(updatedSubscription, subscriptionPeriods);

    if (
      finalSubscription.status !== subscription.status ||
      hasRadarChanged(subscription, finalSubscription)
    ) {
      await subscriptionRepository.update(finalSubscription);
    }

    if (finalSubscription.status !== subscription.status && finalSubscription.status === 'SUSPENDED') {
      suspendedCount++;

      const client = clients.find((c) => c.id === subscription.clientId);
      if (client) {
        const result = await sendNotificationWithThrottle(client, subscription, currentPeriod, 'suspended-notice', organizationId, organization);
        if (result.sent) {
          notificationCount++;
        } else {
          notificationErrors.push(result.error);
        }
      }

      await recordDomainEvent(
        'subscription.suspended',
        organizationId,
        'subscription',
        subscription.id,
        { kitNumber: subscription.kitNumber }
      );
    }

    if (finalSubscription.status === 'ACTIVE') {
        if (
          isDateAfter(now, currentPeriod.endDate) || areSameDay(now, currentPeriod.endDate)
        ) {
          try {
            const plan = plansById.get(subscription.planId);
            if (!plan) continue;

          const nextPeriod = businessService.createNextBillingPeriod({
            currentPeriod,
            subscription,
            plan,
          });

          const scopedNextPeriod = { ...nextPeriod, organizationId };
          await billingPeriodRepository.create(scopedNextPeriod);
          generatedCount++;
          const radarWithNextPeriod = applyRadarToSubscription(finalSubscription, [
            ...subscriptionPeriods,
            scopedNextPeriod,
          ]);
          await subscriptionRepository.update(radarWithNextPeriod);
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
            const result = await sendNotificationWithThrottle(client, subscription, currentPeriod, 'reminder', organizationId, organization);
            if (result.sent) {
              notificationCount++;
            } else {
              notificationErrors.push(result.error);
            }
          } else if (daysUntilDue === 0) {
            const result = await sendNotificationWithThrottle(client, subscription, currentPeriod, 'suspension-warning', organizationId, organization);
            if (result.sent) {
              notificationCount++;
            } else {
              notificationErrors.push(result.error);
            }
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

  if (notificationErrors.length > 0) {
    console.error(
      `[Daily Job] ${notificationErrors.length} notificación(es) fallaron (org ${organizationId}):`,
      notificationErrors
    );
  }

  console.log(
    `[Daily Job] Completado (org ${organizationId}) - Períodos vencidos: ${overdueCount}, Períodos generados: ${generatedCount}, Suscripciones suspendidas: ${suspendedCount}, Notificaciones enviadas: ${notificationCount}`
  );

  return { overdue: overdueCount, generated: generatedCount, suspended: suspendedCount, notifications: notificationCount, errors: notificationErrors };
}

export async function scheduleOrganization(organizationId: string): Promise<boolean> {
  const existing = scheduledTasks.get(organizationId);
  if (existing) {
    existing.stop();
    scheduledTasks.delete(organizationId);
  }

  const config = await schedulerConfigRepository.getConfig(organizationId);

  if (!config.enabled) {
    console.log(`[Scheduler] Organización ${organizationId} con enabled=false. No se programa cron.`);
    return false;
  }

  if (!cron.validate(config.cronSchedule)) {
    console.error(`[Scheduler] Expresión cron inválida para org ${organizationId} ("${config.cronSchedule}"). No se programa.`);
    return false;
  }

  const task = cron.schedule(
    config.cronSchedule,
    () => {
      console.log(`[Scheduler] Tick programado para org ${organizationId}.`);
      void runDailyJobForOrganization(organizationId, 'scheduled').catch((err) => {
        console.error(`[Scheduler] Error en ejecución automática para org ${organizationId}:`, err);
      });
    },
    { timezone: SCHEDULER_TIMEZONE, scheduled: true }
  );

  scheduledTasks.set(organizationId, task);
  console.log(`[Scheduler] Cron programado para org ${organizationId}: "${config.cronSchedule}" (timezone: ${SCHEDULER_TIMEZONE}).`);
  return true;
}

export async function rescheduleAllOrganizations(): Promise<void> {
  const organizations = await organizationRepository.list();
  for (const organization of organizations) {
    const alreadyScheduled = scheduledTasks.has(organization.id);
    if (!organization.active) {
      if (alreadyScheduled) {
        const existing = scheduledTasks.get(organization.id);
        if (existing) {
          existing.stop();
        }
        scheduledTasks.delete(organization.id);
        console.log(`[Scheduler] Organización ${organization.id} inactiva. Cron detenido.`);
      }
      continue;
    }
    await scheduleOrganization(organization.id);
  }
}

export async function startScheduler(): Promise<void> {
  console.log(`[Scheduler] Iniciando scheduler por organización (timezone: ${SCHEDULER_TIMEZONE}).`);
  await rescheduleAllOrganizations();
  console.log(`[Scheduler] Crons activos: ${scheduledTasks.size}.`);
}

export function stopScheduler(): void {
  for (const [organizationId, task] of scheduledTasks) {
    task.stop();
    console.log(`[Scheduler] Cron detenido para org ${organizationId}.`);
  }
  scheduledTasks.clear();
}

async function sendWhatsAppNotification(
  client: { id: string; firstName: string; lastName: string; phone: string },
  subscription: { kitNumber: string },
  period: { endDate: Date },
  type: 'reminder' | 'suspension-warning' | 'suspended-notice',
  organizationId: string,
  organization?: Organization
): Promise<{ sent: true } | { sent: false; error: NotificationFailure }> {
  const clientFullName = `${client.firstName} ${client.lastName}`;

  const failure = (errorMessage: string, errorCode?: number): { sent: false; error: NotificationFailure } => ({
    sent: false,
    error: {
      type,
      clientName: clientFullName,
      phone: client.phone,
      errorCode,
      errorMessage,
    },
  });

  const templateMap: Record<string, string | undefined> = {
    'reminder': process.env.TWILIO_TEMPLATE_SUBSCRIPTION_REMINDER_3DAYS_2V,
    'suspension-warning': process.env.TWILIO_TEMPLATE_SUBSCRIPTION_CUTOFF_DAY_2V,
    'suspended-notice': process.env.TWILIO_TEMPLATE_SUBSCRIPTION_SUSPENDED_NOTICE_2V,
  };

  const templateName = templateMap[type];

  if (!templateName) {
    return failure(`Template no configurado para la notificación ${type} (revisa las variables de entorno TWILIO_TEMPLATE_*).`);
  }

  if (!resolveTwilioCredentials(organization)) {
    return failure('La organización no tiene credenciales de Twilio configuradas o están deshabilitadas.');
  }

  const endDateStr = period.endDate.toISOString().split('T')[0];

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
    }, organization);

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
    try {
      await whatsappConversationRepository.upsertFromMessage(whatsappMsg, organizationId);
    } catch (conversationError) {
      console.error('[WhatsApp] Error actualizando conversación:', conversationError);
    }
    console.log(`[WhatsApp] Notificación ${type} enviada a ${clientFullName} (${client.phone})`);
    return { sent: true };
  } catch (error) {
    console.error(`[WhatsApp] Error enviando notificación ${type} a ${clientFullName}:`, error);
    const twilioError = extractTwilioError(error);
    if (twilioError) {
      return failure(`${twilioError.message}${twilioError.moreInfo ? ` (${twilioError.moreInfo})` : ''}`, twilioError.code);
    }
    return failure(error instanceof Error ? error.message : String(error));
  }
}

async function sendNotificationWithThrottle(
  client: { id: string; firstName: string; lastName: string; phone: string },
  subscription: { kitNumber: string },
  period: { endDate: Date },
  type: 'reminder' | 'suspension-warning' | 'suspended-notice',
  organizationId: string,
  organization?: Organization
): Promise<{ sent: true } | { sent: false; error: NotificationFailure }> {
  const accountSid = organization?.twilio?.accountSid
    ? organization.twilio.accountSid.trim()
    : undefined;

  if (accountSid) {
    await throttleByAccount(accountSid);
  }

  return sendWhatsAppNotification(client, subscription, period, type, organizationId, organization);
}

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
import { flushStatsRecompute } from './stats-service';
import {
  BillingPeriod,
  WhatsAppMessage,
  DomainEventType,
  Organization,
  OrganizationWhatsAppConfig,
  SchedulerLog,
  Subscription,
} from '../domain/entities';
import { resolveWhatsAppNotificationConfig } from './whatsapp-configuration';

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
  const notificationConfig = organization
    ? resolveWhatsAppNotificationConfig(organization)
    : undefined;

  // Ventana de recordatorios en días UTC. Incluye el día 0 para que el aviso de
  // corte siga funcionando aunque reminderDaysBefore esté vacío.
  const startOfTodayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const reminderDays = notificationConfig?.rules.reminderDaysBefore ?? [];
  const maxReminderDays = reminderDays.length > 0 ? Math.max(...reminderDays) : 0;
  const reminderWindowEnd = new Date(startOfTodayUtc);
  reminderWindowEnd.setUTCDate(reminderWindowEnd.getUTCDate() + Math.max(maxReminderDays, 0));
  const shouldQueryReminders =
    reminderDays.length > 0 || notificationConfig?.rules.dueDateWarningEnabled === true;

  // Conjuntos de acción dirigidos por organización:
  // 1) PENDING vencidos -> marcar OVERDUE + evaluar suspensión.
  // 2) PENDING por vencer -> recordatorios / aviso de corte.
  // 3) ACTIVE con período actual terminado (PAID/OVERDUE) -> generar ciclo.
  // La unión de estas suscripciones es el alcance real del job; así una
  // suscripción SUSPENDED con un PENDING pasado no deja fuera al resto.
  const [overdueCandidates, reminderCandidates, generationCandidates] = await Promise.all([
    billingPeriodRepository.listPendingOverdueCandidates(organizationId, now, 500),
    shouldQueryReminders
      ? billingPeriodRepository.listReminderWindowCandidates(
          organizationId,
          startOfTodayUtc,
          reminderWindowEnd,
          500
        )
      : Promise.resolve([] as BillingPeriod[]),
    subscriptionRepository.listGenerationCandidates(organizationId, now, 500),
  ]);

  const actionSubscriptionIds = new Set<string>([
    ...overdueCandidates.map((p) => p.subscriptionId),
    ...reminderCandidates.map((p) => p.subscriptionId),
    ...generationCandidates.map((s) => s.id),
  ]);
  const touchedSubscriptionIds = [...actionSubscriptionIds];

  const [overdueForTouched, subscriptions, clients, allPlans] = await Promise.all([
    touchedSubscriptionIds.length > 0
      ? billingPeriodRepository.listBySubscriptionIds(touchedSubscriptionIds, organizationId)
      : Promise.resolve([] as BillingPeriod[]),
    touchedSubscriptionIds.length > 0
      ? subscriptionRepository.listByIds(touchedSubscriptionIds, organizationId)
      : Promise.resolve([] as Subscription[]),
    clientRepository.listByOrganization(organizationId),
    planRepository.listByOrganization(organizationId),
  ]);
  // overdueForTouched trae todos los períodos (PAID/PENDING/OVERDUE) de las
  // suscripciones accionables; se conservan completos para que la generación de
  // ciclo vea el período actual aunque esté PAID. Los candidatos vencidos se
  // incluyen de forma defensiva por si la lectura por lotes no los devuelve.
  const seenPeriodIds = new Set<string>();
  const allPeriods = [...overdueForTouched, ...overdueCandidates].filter((p) =>
    seenPeriodIds.has(p.id) ? false : (seenPeriodIds.add(p.id), true)
  );

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

    let subscriptionPeriods = updatedPeriods
      .filter((p) => p.subscriptionId === subscription.id)
      .sort((a, b) => b.endDate.getTime() - a.endDate.getTime());

    if (subscriptionPeriods.length === 0) {
      // Sin períodos visibles para esta suscripción: rehidratar solo el actual
      // desde el radar (currentPeriodId) en vez de leer todo su historial.
      if (subscription.currentPeriodId) {
        const currentFromRadar = await billingPeriodRepository.getByIdScoped(
          subscription.currentPeriodId,
          organizationId
        );
        if (currentFromRadar) {
          subscriptionPeriods = [currentFromRadar];
        }
      }
      if (subscriptionPeriods.length === 0) continue;
    } else if (
      subscription.currentPeriodId &&
      !subscriptionPeriods.some((p) => p.id === subscription.currentPeriodId)
    ) {
      const currentFromRadar = await billingPeriodRepository.getByIdScoped(
        subscription.currentPeriodId,
        organizationId
      );
      if (currentFromRadar) {
        subscriptionPeriods = [currentFromRadar, ...subscriptionPeriods].sort(
          (a, b) => b.endDate.getTime() - a.endDate.getTime()
        );
      }
    }

    const currentPeriod = subscriptionPeriods[0];
    if (!currentPeriod) continue;

    const updatedSubscription = businessService.evaluateSubscriptionStatus(
      subscription,
      subscriptionPeriods
    );

    const finalSubscription = applyRadarToSubscription(updatedSubscription, subscriptionPeriods);
    if (subscription.totalPeriods !== undefined) {
      finalSubscription.totalPeriods = subscription.totalPeriods;
    }

    if (
      finalSubscription.status !== subscription.status ||
      hasRadarChanged(subscription, finalSubscription)
    ) {
      await subscriptionRepository.update(finalSubscription);
    }

    if (finalSubscription.status !== subscription.status && finalSubscription.status === 'SUSPENDED') {
      suspendedCount++;

      const client = clients.find((c) => c.id === subscription.clientId);
      if (client && notificationConfig?.rules.suspensionNoticeEnabled !== false) {
        const outcome = await sendNotificationWithThrottleAndDedup(
          client,
          subscription,
          currentPeriod,
          'suspended-notice',
          organizationId,
          organization,
          notificationConfig,
          startOfTodayUtc
        );
        if (outcome.status === 'sent') {
          notificationCount++;
        } else if (outcome.status === 'failed') {
          notificationErrors.push(outcome.error);
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
        const alreadyExists = subscriptionPeriods.some(
          (p) => p.id !== currentPeriod.id && p.startDate.getTime() === currentPeriod.endDate.getTime()
        );
        if (alreadyExists) {
          console.log(`[Daily Job] El siguiente período de ${subscription.id} ya existe (adelanto previo). Skipping.`);
        } else {
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
            if (subscription.totalPeriods !== undefined) {
              radarWithNextPeriod.totalPeriods = subscription.totalPeriods + 1;
            }
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
      }

      if (currentPeriod.status === 'PENDING') {
        const endDateNormalized = new Date(Date.UTC(currentPeriod.endDate.getUTCFullYear(), currentPeriod.endDate.getUTCMonth(), currentPeriod.endDate.getUTCDate()));
        const nowNormalized = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const daysUntilDue = Math.round((endDateNormalized.getTime() - nowNormalized.getTime()) / (1000 * 60 * 60 * 24));
        const client = clients.find((c) => c.id === subscription.clientId);
        if (client) {
          if (notificationConfig?.rules.reminderDaysBefore.includes(daysUntilDue)) {
            const outcome = await sendNotificationWithThrottleAndDedup(
              client,
              subscription,
              currentPeriod,
              'reminder',
              organizationId,
              organization,
              notificationConfig,
              startOfTodayUtc
            );
            if (outcome.status === 'sent') {
              notificationCount++;
            } else if (outcome.status === 'failed') {
              notificationErrors.push(outcome.error);
            }
          } else if (
            daysUntilDue === 0 &&
            notificationConfig?.rules.dueDateWarningEnabled
          ) {
            const outcome = await sendNotificationWithThrottleAndDedup(
              client,
              subscription,
              currentPeriod,
              'suspension-warning',
              organizationId,
              organization,
              notificationConfig,
              startOfTodayUtc
            );
            if (outcome.status === 'sent') {
              notificationCount++;
            } else if (outcome.status === 'failed') {
              notificationErrors.push(outcome.error);
            }
          }
        }
      }
    }
  }

  await schedulerConfigRepository.updateConfig({ lastRun: now }, organizationId);
  // Reconciliación diaria: el job es el punto que ve todas las mutaciones del
  // día (vencidos/suspendidos/generados); fuerza el recompute en vez de
  // depender del debounce, que puede perderse si el proceso rota.
  try {
    await flushStatsRecompute(organizationId);
  } catch (error) {
    console.error(`[Daily Job] Error reconciliando organizationStats/${organizationId}:`, error);
  }

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

type NotificationType = 'reminder' | 'suspension-warning' | 'suspended-notice';

function resolveNotificationTemplateName(
  type: NotificationType,
  config?: OrganizationWhatsAppConfig
): string | undefined {
  if (type === 'reminder') return config?.templates.reminder;
  if (type === 'suspension-warning') return config?.templates.dueDateWarning;
  return config?.templates.suspensionNotice;
}

function buildNotificationVariables(
  type: NotificationType,
  client: { firstName: string; lastName: string },
  subscription: { kitNumber: string },
  period: { endDate: Date }
): Record<string, string> {
  const clientFullName = `${client.firstName} ${client.lastName}`;
  const endDateStr = period.endDate.toISOString().split('T')[0];
  if (type === 'suspended-notice') {
    return {
      '1': clientFullName,
      '2': subscription.kitNumber,
    };
  }
  if (type === 'suspension-warning') {
    return {
      '1': clientFullName,
      '2': subscription.kitNumber,
      '3': endDateStr,
    };
  }
  return {
    '1': clientFullName,
    '2': endDateStr,
  };
}

function buildNotificationMessageBody(
  templateName: string,
  variables: Record<string, string>
): string {
  return `[Template: ${templateName}] Variables: ${JSON.stringify(variables)}`;
}

async function sendWhatsAppNotification(
  client: { id: string; firstName: string; lastName: string; phone: string },
  subscription: { kitNumber: string },
  period: { endDate: Date },
  type: NotificationType,
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

  const notificationConfig = organization
    ? resolveWhatsAppNotificationConfig(organization)
    : undefined;
  const templateName = resolveNotificationTemplateName(type, notificationConfig);

  if (!templateName) {
    return failure(`Plantilla no configurada para la notificación ${type} en la configuración de WhatsApp de la organización.`);
  }

  if (!resolveTwilioCredentials(organization)) {
    return failure('La organización no tiene credenciales de Twilio configuradas o están deshabilitadas.');
  }

  const variables = buildNotificationVariables(type, client, subscription, period);

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
      body: buildNotificationMessageBody(templateName, variables),
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
  type: NotificationType,
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

type NotificationOutcome =
  | { status: 'sent' }
  | { status: 'duplicate' }
  | { status: 'failed'; error: NotificationFailure };

async function sendNotificationWithThrottleAndDedup(
  client: { id: string; firstName: string; lastName: string; phone: string },
  subscription: { kitNumber: string },
  period: { endDate: Date },
  type: NotificationType,
  organizationId: string,
  organization: Organization | undefined,
  notificationConfig: OrganizationWhatsAppConfig | undefined,
  since: Date
): Promise<NotificationOutcome> {
  const templateName = resolveNotificationTemplateName(type, notificationConfig);
  if (templateName) {
    const body = buildNotificationMessageBody(
      templateName,
      buildNotificationVariables(type, client, subscription, period)
    );
    const alreadySent = await whatsappMessageRepository.existsOutboundMessageSince({
      organizationId,
      phone: client.phone,
      body,
      since,
    });
    if (alreadySent) {
      console.log(`[WhatsApp] Notificación ${type} ya enviada hoy a ${client.phone}. Skipping.`);
      return { status: 'duplicate' };
    }
  }

  const result = await sendNotificationWithThrottle(
    client,
    subscription,
    period,
    type,
    organizationId,
    organization
  );
  return result.sent ? { status: 'sent' } : { status: 'failed', error: result.error };
}

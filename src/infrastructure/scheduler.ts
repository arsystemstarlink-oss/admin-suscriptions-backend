import cron, { ScheduledTask } from 'node-cron';
import {
  billingPeriodRepository,
  subscriptionRepository,
  planRepository,
  schedulerConfigRepository,
  clientRepository,
  whatsappMessageRepository,
} from '../infrastructure/repositories';
import { SubscriptionBusinessService } from '../domain/subscription-service';
import { isDateAfter, areSameDay, createId } from '../domain/business-rules';
import { whatsappService } from './whatsapp-service';
import { WhatsAppMessage } from '../domain/entities';

const businessService = new SubscriptionBusinessService();

let currentTask: ScheduledTask | null = null;

export async function runDailyJob(): Promise<void> {
  const now = new Date();
  console.log(`[Daily Job] Ejecutando revisión automática - ${now.toISOString()}`);

  const allPeriods = await billingPeriodRepository.list();
  const subscriptions = await subscriptionRepository.list();
  const clients = await clientRepository.list();

  let overdueCount = 0;
  let generatedCount = 0;
  let suspendedCount = 0;
  let notificationCount = 0;

  const updatedPeriods = businessService.markPendingPeriodsOverdue(allPeriods, now);
  
  for (const period of updatedPeriods) {
    const original = allPeriods.find((p) => p.id === period.id);
    if (original && original.status !== period.status) {
      await billingPeriodRepository.update(period);
      overdueCount++;
    }
  }

  for (const subscription of subscriptions) {
    const subscriptionPeriods = updatedPeriods
      .filter((p) => p.subscriptionId === subscription.id)
      .sort((a, b) => b.endDate.getTime() - a.endDate.getTime());

    const currentPeriod = subscriptionPeriods[0];
    if (!currentPeriod) continue;

    if (
      currentPeriod.status === 'PAID' &&
      (isDateAfter(now, currentPeriod.endDate) || areSameDay(now, currentPeriod.endDate))
    ) {
      try {
        const plan = await planRepository.getById(subscription.planId);
        if (!plan) continue;

        const nextPeriod = businessService.createNextBillingPeriod({
          currentPeriod,
          subscription,
          plan,
        });

        await billingPeriodRepository.create(nextPeriod);
        generatedCount++;
      } catch (error) {
        console.error(`[Daily Job] Error generando período para suscripción ${subscription.id}:`, error);
      }
    }

    const updatedSubscription = businessService.evaluateSubscriptionStatus(
      subscription,
      subscriptionPeriods
    );

    if (updatedSubscription.status !== subscription.status) {
      await subscriptionRepository.update(updatedSubscription);
      if (updatedSubscription.status === 'SUSPENDED') {
        suspendedCount++;
        
        const client = clients.find(c => c.id === subscription.clientId);
        if (client) {
          await sendWhatsAppNotification(client, subscription, currentPeriod, 'suspended-notice');
          notificationCount++;
        }
      }
    }

    const finalSubscription = updatedSubscription.status !== subscription.status 
      ? updatedSubscription 
      : subscription;

    if (finalSubscription.status === 'ACTIVE') {
      if (currentPeriod.status === 'PENDING' || currentPeriod.status === 'PAID') {
        const endDateNormalized = new Date(Date.UTC(currentPeriod.endDate.getUTCFullYear(), currentPeriod.endDate.getUTCMonth(), currentPeriod.endDate.getUTCDate()));
        const nowNormalized = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const daysUntilDue = Math.round((endDateNormalized.getTime() - nowNormalized.getTime()) / (1000 * 60 * 60 * 24));
        const client = clients.find(c => c.id === subscription.clientId);
        if (client) {
          if (daysUntilDue === 3) {
            await sendWhatsAppNotification(client, subscription, currentPeriod, 'reminder');
            notificationCount++;
          } else if (daysUntilDue === 0) {
            await sendWhatsAppNotification(client, subscription, currentPeriod, 'suspension-warning');
            notificationCount++;
          }
        }
      }
    }
  }

  await schedulerConfigRepository.updateConfig({ lastRun: now });

  console.log(
    `[Daily Job] Completado - Períodos vencidos: ${overdueCount}, Períodos generados: ${generatedCount}, Suscripciones suspendidas: ${suspendedCount}, Notificaciones enviadas: ${notificationCount}`
  );
}

async function sendWhatsAppNotification(
  client: { id: string; name: string; phone: string },
  subscription: { kitNumber: string },
  period: { endDate: Date },
  type: 'reminder' | 'suspension-warning' | 'suspended-notice'
): Promise<void> {
  const templateMap: Record<string, string | undefined> = {
    'reminder': process.env.TWILIO_TEMPLATE_PAYMENT_REMINDER,
    'suspension-warning': process.env.TWILIO_TEMPLATE_SUSPENSION_WARNING,
    'suspended-notice': process.env.TWILIO_TEMPLATE_SUSPENDED_NOTICE,
  };

  const templateName = templateMap[type];

  if (!templateName) {
    console.log(`[WhatsApp] Template no configurado para ${type}. Skipping.`);
    return;
  }

  const endDateStr = period.endDate.toISOString().split('T')[0];
  
  let variables: Record<string, string>;
  if (type === 'suspended-notice') {
    variables = {
      '1': client.name,
      '2': subscription.kitNumber,
    };
  } else if (type === 'suspension-warning') {
    variables = {
      '1': client.name,
      '2': subscription.kitNumber,
      '3': endDateStr,
    };
  } else {
    variables = {
      '1': client.name,
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
    console.log(`[WhatsApp] Notificación ${type} enviada a ${client.name} (${client.phone})`);
  } catch (error) {
    console.error(`[WhatsApp] Error enviando notificación ${type} a ${client.name}:`, error);
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
  });

  console.log(`[Scheduler] Daily Job programado con cron: ${config.cronSchedule} (enabled: ${config.enabled})`);
}

export async function reschedule(): Promise<void> {
  await scheduleFromConfig();
}

export async function startScheduler(): Promise<void> {
  await scheduleFromConfig();
}

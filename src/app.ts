import { Client, Plan } from './domain/entities';
import { InMemoryRepository } from './domain/in-memory-repository';
import { SubscriptionBusinessService } from './domain/subscription-service';

const clientRepo = new InMemoryRepository<Client>();
const planRepo = new InMemoryRepository<Plan>();
const subscriptionService = new SubscriptionBusinessService();

const client: Client = {
  id: 'client_01',
  organizationId: 'org_demo',
  firstName: 'Juan',
  lastName: 'Pérez',
  phone: '+5491123456789',
  email: 'juan.perez@example.com',
  address: 'Calle Falsa 123',
  notes: 'Cliente residencial.',
  createdAt: new Date(),
};
clientRepo.create(client);

const plan: Plan = {
  id: 'plan_residencial',
  organizationId: 'org_demo',
  name: 'Residencial',
  price: 35,
  description: 'Servicio residencial básico',
  active: true,
  createdAt: new Date(),
};
planRepo.create(plan);

const { subscription, billingPeriods } = subscriptionService.createSubscription({
  organizationId: 'org_demo',
  clientId: client.id,
  plan,
  kitNumber: 'KIT-001',
  billingDay: 5,
  maxOverduePeriods: 2,
  registrationDate: new Date('2026-07-20T10:00:00Z'),
});

const firstBillingPeriod = billingPeriods[0];

console.log('Suscripción creada:');
console.log(subscription);
console.log('Primer período creado como PAID:');
console.log(firstBillingPeriod);

const nextPeriod = subscriptionService.createNextBillingPeriod({
  currentPeriod: firstBillingPeriod,
  subscription,
  plan,
});

console.log('Siguiente período generado automáticamente:');
console.log(nextPeriod);

const overduePeriods = subscriptionService.markPendingPeriodsOverdue([
  {
    ...nextPeriod,
    status: 'PENDING',
  },
], new Date('2026-09-06T00:00:00Z'));

console.log('Períodos evaluados en fecha de corte:');
console.log(overduePeriods);

const suspendedSubscription = subscriptionService.evaluateSubscriptionStatus(subscription, [
  { ...nextPeriod, status: 'OVERDUE' },
  { ...nextPeriod, status: 'OVERDUE', id: 'copy_2' },
]);

console.log('Suscripción después de evaluar deuda acumulada:');
console.log(suspendedSubscription);

import { SubscriptionBusinessService, HistoricalPaymentInput } from '../domain/subscription-service';
import { Client, Plan, Subscription, BillingPeriod } from '../domain/entities';
import { createId, getBillingPeriodRange, isValidBillingDay } from '../domain/business-rules';

describe('SubscriptionBusinessService', () => {
  let service: SubscriptionBusinessService;
  let testClient: Client;
  let testPlan: Plan;

  beforeEach(() => {
    service = new SubscriptionBusinessService();
    
    testClient = {
      id: 'client_test_1',
      name: 'Cliente Test',
      phone: '+1234567890',
      email: 'test@example.com',
      createdAt: new Date(),
    };

    testPlan = {
      id: 'plan_test_1',
      name: 'Plan Test',
      price: 50,
      description: 'Plan de prueba',
      active: true,
      createdAt: new Date(),
    };
  });

  describe('createSubscription', () => {
    it('debería crear una suscripción con el primer período PAID', () => {
      const registrationDate = new Date('2026-07-20T10:00:00Z');
      
      const result = service.createSubscription({
        clientId: testClient.id,
        plan: testPlan,
        kitNumber: 'KIT-001',
        billingDay: 5,
        maxOverduePeriods: 2,
        registrationDate,
      });

      expect(result.subscription).toBeDefined();
      expect(result.subscription.status).toBe('ACTIVE');
      expect(result.subscription.clientId).toBe(testClient.id);
      expect(result.subscription.planId).toBe(testPlan.id);
      expect(result.subscription.billingDay).toBe(5);

      expect(result.billingPeriods).toBeDefined();
      expect(result.billingPeriods.length).toBe(1);
      expect(result.billingPeriods[0].status).toBe('PAID');
      expect(result.billingPeriods[0].amount).toBe(testPlan.price);
      expect(result.billingPeriods[0].subscriptionId).toBe(result.subscription.id);
    });

    it('debería rechazar un billingDay inválido', () => {
      expect(() => {
        service.createSubscription({
          clientId: testClient.id,
          plan: testPlan,
          kitNumber: 'KIT-001',
          billingDay: 29,
          maxOverduePeriods: 2,
          registrationDate: new Date(),
        });
      }).toThrow('El día de corte debe ser un número entre 1 y 28.');
    });

    it('debería rechazar un plan inactivo', () => {
      const inactivePlan = { ...testPlan, active: false };

      expect(() => {
        service.createSubscription({
          clientId: testClient.id,
          plan: inactivePlan,
          kitNumber: 'KIT-001',
          billingDay: 5,
          maxOverduePeriods: 2,
          registrationDate: new Date(),
        });
      }).toThrow('El plan debe existir y estar activo.');
    });

    it('debería rechazar un clientId vacío', () => {
      expect(() => {
        service.createSubscription({
          clientId: '',
          plan: testPlan,
          kitNumber: 'KIT-001',
          billingDay: 5,
          maxOverduePeriods: 2,
          registrationDate: new Date(),
        });
      }).toThrow('El cliente es obligatorio.');
    });

    it('debería retornar billingPeriods y summary en la respuesta', () => {
      const result = service.createSubscription({
        clientId: testClient.id,
        plan: testPlan,
        kitNumber: 'KIT-001',
        billingDay: 5,
        maxOverduePeriods: 2,
        registrationDate: new Date('2026-07-20T10:00:00Z'),
      });

      expect(result.billingPeriods).toBeDefined();
      expect(Array.isArray(result.billingPeriods)).toBe(true);
      expect(result.billingPeriods.length).toBe(1);
      expect(result.summary).toBeDefined();
      expect(result.summary.totalPeriods).toBe(1);
      expect(result.summary.paidPeriods).toBe(1);
      expect(result.summary.totalPaid).toBe(testPlan.price);
    });
  });

  describe('createSubscription (retroactiva)', () => {
    it('debería crear suscripción retroactiva con períodos históricos pagados', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date(2026, 6, 30));

      const activationDate = new Date(2026, 4, 5);
      const historicalPayments: HistoricalPaymentInput[] = [
        {
          periodLabel: 'Mayo - Junio',
          startDate: new Date(2026, 4, 5),
          endDate: new Date(2026, 5, 6),
          amount: testPlan.price,
          paidAt: new Date(2026, 5, 5, 10, 30),
          paymentMethod: 'CASH',
          notes: 'Pago en oficina',
        },
        {
          periodLabel: 'Junio - Julio',
          startDate: new Date(2026, 5, 6),
          endDate: new Date(2026, 6, 6),
          amount: testPlan.price,
          paidAt: new Date(2026, 6, 4, 15, 20),
          paymentMethod: 'TRANSFER',
          notes: 'Transferencia bancaria',
        },
      ];

      const result = service.createSubscription({
        clientId: testClient.id,
        plan: testPlan,
        kitNumber: 'KIT-002',
        billingDay: 6,
        maxOverduePeriods: 2,
        registrationDate: new Date(),
        activationDate,
        historicalPayments,
      });

      expect(result.subscription.activationDate).toEqual(activationDate);
      expect(result.billingPeriods.length).toBe(3);

      expect(result.billingPeriods[0].status).toBe('PAID');
      expect(result.billingPeriods[0].paymentMethod).toBe('CASH');
      expect(result.billingPeriods[0].startDate).toEqual(new Date(2026, 4, 5));
      expect(result.billingPeriods[0].endDate).toEqual(new Date(2026, 5, 6));

      expect(result.billingPeriods[1].status).toBe('PAID');
      expect(result.billingPeriods[1].paymentMethod).toBe('TRANSFER');
      expect(result.billingPeriods[1].startDate).toEqual(new Date(2026, 5, 6));
      expect(result.billingPeriods[1].endDate).toEqual(new Date(2026, 6, 6));

      expect(result.billingPeriods[2].status).toBe('PENDING');
      expect(result.billingPeriods[2].startDate).toEqual(new Date(2026, 6, 6));
      expect(result.billingPeriods[2].endDate).toEqual(new Date(2026, 7, 6));

      expect(result.summary.totalPeriods).toBe(3);
      expect(result.summary.paidPeriods).toBe(2);
      expect(result.summary.pendingPeriods).toBe(1);
      expect(result.summary.overduePeriods).toBe(0);
      expect(result.summary.totalPaid).toBe(100);
      expect(result.summary.totalPending).toBe(50);

      jest.useRealTimers();
    });

    it('debería crear suscripción retroactiva sin pagos históricos (todos OVERDUE)', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date(2026, 6, 30));

      const activationDate = new Date(2026, 4, 5);

      const result = service.createSubscription({
        clientId: testClient.id,
        plan: testPlan,
        kitNumber: 'KIT-003',
        billingDay: 6,
        maxOverduePeriods: 3,
        registrationDate: new Date(),
        activationDate,
      });

      expect(result.billingPeriods.length).toBe(3);
      expect(result.billingPeriods[0].status).toBe('OVERDUE');
      expect(result.billingPeriods[1].status).toBe('OVERDUE');
      expect(result.billingPeriods[2].status).toBe('PENDING');

      expect(result.summary.overduePeriods).toBe(2);
      expect(result.summary.pendingPeriods).toBe(1);
      expect(result.summary.totalPending).toBe(150);

      jest.useRealTimers();
    });

    it('debería rechazar fecha de activación futura', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date(2026, 6, 30));

      expect(() => {
        service.createSubscription({
          clientId: testClient.id,
          plan: testPlan,
          kitNumber: 'KIT-001',
          billingDay: 6,
          maxOverduePeriods: 2,
          registrationDate: new Date(),
          activationDate: new Date(2026, 11, 31),
          historicalPayments: [],
        });
      }).toThrow('La fecha de activación no puede ser futura.');

      jest.useRealTimers();
    });

    it('debería rechazar pagos con fecha futura', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date(2026, 6, 30));

      expect(() => {
        service.createSubscription({
          clientId: testClient.id,
          plan: testPlan,
          kitNumber: 'KIT-001',
          billingDay: 6,
          maxOverduePeriods: 2,
          registrationDate: new Date(),
          activationDate: new Date(2026, 4, 5),
          historicalPayments: [
            {
              periodLabel: 'Mayo - Junio',
              startDate: new Date(2026, 4, 5),
              endDate: new Date(2026, 5, 6),
              amount: testPlan.price,
              paidAt: new Date(2027, 0, 1),
              paymentMethod: 'CASH',
            },
          ],
        });
      }).toThrow('El pago 0 tiene fecha futura.');

      jest.useRealTimers();
    });

    it('debería rechazar períodos que inician antes de la activación', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date(2026, 6, 30));

      expect(() => {
        service.createSubscription({
          clientId: testClient.id,
          plan: testPlan,
          kitNumber: 'KIT-001',
          billingDay: 6,
          maxOverduePeriods: 2,
          registrationDate: new Date(),
          activationDate: new Date(2026, 4, 5),
          historicalPayments: [
            {
              periodLabel: 'Abril - Mayo',
              startDate: new Date(2026, 3, 1),
              endDate: new Date(2026, 4, 6),
              amount: testPlan.price,
              paidAt: new Date(2026, 4, 1),
              paymentMethod: 'CASH',
            },
          ],
        });
      }).toThrow('El período 0 inicia antes de la activación.');

      jest.useRealTimers();
    });

    it('debería rechazar períodos con rango inválido (endDate <= startDate)', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date(2026, 6, 30));

      expect(() => {
        service.createSubscription({
          clientId: testClient.id,
          plan: testPlan,
          kitNumber: 'KIT-001',
          billingDay: 6,
          maxOverduePeriods: 2,
          registrationDate: new Date(),
          activationDate: new Date(2026, 4, 5),
          historicalPayments: [
            {
              periodLabel: 'Invalid',
              startDate: new Date(2026, 5, 6),
              endDate: new Date(2026, 4, 5),
              amount: testPlan.price,
              paidAt: new Date(2026, 5, 1),
              paymentMethod: 'CASH',
            },
          ],
        });
      }).toThrow('El período 0 tiene rango inválido.');

      jest.useRealTimers();
    });

    it('debería rechazar monto diferente al precio del plan', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date(2026, 6, 30));

      expect(() => {
        service.createSubscription({
          clientId: testClient.id,
          plan: testPlan,
          kitNumber: 'KIT-001',
          billingDay: 6,
          maxOverduePeriods: 2,
          registrationDate: new Date(),
          activationDate: new Date(2026, 4, 5),
          historicalPayments: [
            {
              periodLabel: 'Mayo - Junio',
              startDate: new Date(2026, 4, 5),
              endDate: new Date(2026, 5, 6),
              amount: 30,
              paidAt: new Date(2026, 5, 1),
              paymentMethod: 'CASH',
            },
          ],
        });
      }).toThrow('El pago 0 tiene monto diferente al precio del plan.');

      jest.useRealTimers();
    });

    it('debería rechazar INITIAL_PAYMENT en pagos históricos', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date(2026, 6, 30));

      expect(() => {
        service.createSubscription({
          clientId: testClient.id,
          plan: testPlan,
          kitNumber: 'KIT-001',
          billingDay: 6,
          maxOverduePeriods: 2,
          registrationDate: new Date(),
          activationDate: new Date(2026, 4, 5),
          historicalPayments: [
            {
              periodLabel: 'Mayo - Junio',
              startDate: new Date(2026, 4, 5),
              endDate: new Date(2026, 5, 6),
              amount: testPlan.price,
              paidAt: new Date(2026, 5, 1),
              paymentMethod: 'INITIAL_PAYMENT',
            },
          ],
        });
      }).toThrow('El pago 0 no puede usar INITIAL_PAYMENT.');

      jest.useRealTimers();
    });

    it('debería rechazar períodos históricos superpuestos', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date(2026, 6, 30));

      expect(() => {
        service.createSubscription({
          clientId: testClient.id,
          plan: testPlan,
          kitNumber: 'KIT-001',
          billingDay: 6,
          maxOverduePeriods: 2,
          registrationDate: new Date(),
          activationDate: new Date(2026, 4, 5),
          historicalPayments: [
            {
              periodLabel: 'Mayo - Junio',
              startDate: new Date(2026, 4, 5),
              endDate: new Date(2026, 5, 10),
              amount: testPlan.price,
              paidAt: new Date(2026, 5, 1),
              paymentMethod: 'CASH',
            },
            {
              periodLabel: 'Junio - Julio',
              startDate: new Date(2026, 5, 6),
              endDate: new Date(2026, 6, 6),
              amount: testPlan.price,
              paidAt: new Date(2026, 6, 1),
              paymentMethod: 'CASH',
            },
          ],
        });
      }).toThrow('Los períodos históricos se superponen.');

      jest.useRealTimers();
    });

    it('debería permitir activationDate igual a hoy', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date(2026, 6, 30));

      const result = service.createSubscription({
        clientId: testClient.id,
        plan: testPlan,
        kitNumber: 'KIT-004',
        billingDay: 6,
        maxOverduePeriods: 2,
        registrationDate: new Date(),
        activationDate: new Date(2026, 6, 30),
      });

      expect(result.billingPeriods.length).toBe(1);
      expect(result.billingPeriods[0].status).toBe('PENDING');
      expect(result.billingPeriods[0].startDate).toEqual(new Date(2026, 6, 30));

      jest.useRealTimers();
    });

    it('debería crear suscripción SUSPENDED cuando hay suficientes períodos OVERDUE', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date(2026, 6, 30));

      const result = service.createSubscription({
        clientId: testClient.id,
        plan: testPlan,
        kitNumber: 'KIT-005',
        billingDay: 6,
        maxOverduePeriods: 2,
        registrationDate: new Date(),
        activationDate: new Date(2026, 4, 5),
      });

      expect(result.subscription.status).toBe('SUSPENDED');
      expect(result.billingPeriods.length).toBe(3);
      expect(result.billingPeriods[0].status).toBe('OVERDUE');
      expect(result.billingPeriods[1].status).toBe('OVERDUE');
      expect(result.billingPeriods[2].status).toBe('PENDING');

      jest.useRealTimers();
    });

    it('debería crear suscripción ACTIVE cuando no hay suficientes períodos OVERDUE', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date(2026, 6, 30));

      const result = service.createSubscription({
        clientId: testClient.id,
        plan: testPlan,
        kitNumber: 'KIT-006',
        billingDay: 6,
        maxOverduePeriods: 3,
        registrationDate: new Date(),
        activationDate: new Date(2026, 4, 5),
      });

      expect(result.subscription.status).toBe('ACTIVE');
      expect(result.billingPeriods.length).toBe(3);
      expect(result.billingPeriods[0].status).toBe('OVERDUE');
      expect(result.billingPeriods[1].status).toBe('OVERDUE');
      expect(result.billingPeriods[2].status).toBe('PENDING');

      jest.useRealTimers();
    });
  });

  describe('createNextBillingPeriod', () => {
    it('debería generar el siguiente período PENDING', () => {
      const subscription: Subscription = {
        id: 'sub_1',
        clientId: testClient.id,
        planId: testPlan.id,
        kitNumber: 'KIT-001',
        billingDay: 5,
        status: 'ACTIVE',
        maxOverduePeriods: 2,
        createdAt: new Date(),
      };

      const pastDate = new Date('2025-08-06');
      const currentPeriod: BillingPeriod = {
        id: 'period_1',
        subscriptionId: subscription.id,
        periodLabel: 'Julio - Agosto',
        startDate: new Date('2025-07-05'),
        endDate: new Date('2025-08-05'),
        amount: testPlan.price,
        status: 'PAID',
        paidAt: new Date('2025-07-20'),
        paymentMethod: 'INITIAL_PAYMENT',
        createdAt: new Date(),
      };

      jest.useFakeTimers();
      jest.setSystemTime(pastDate);

      const nextPeriod = service.createNextBillingPeriod({
        currentPeriod,
        subscription,
        plan: testPlan,
      });

      expect(nextPeriod.status).toBe('PENDING');
      expect(nextPeriod.amount).toBe(testPlan.price);
      expect(nextPeriod.startDate.getTime()).toBe(currentPeriod.endDate.getTime());

      jest.useRealTimers();
    });

    it('debería rechazar si el período actual no está PAID', () => {
      const subscription: Subscription = {
        id: 'sub_1',
        clientId: testClient.id,
        planId: testPlan.id,
        kitNumber: 'KIT-001',
        billingDay: 5,
        status: 'ACTIVE',
        maxOverduePeriods: 2,
        createdAt: new Date(),
      };

      const pendingPeriod: BillingPeriod = {
        id: 'period_1',
        subscriptionId: subscription.id,
        periodLabel: 'Julio - Agosto',
        startDate: new Date('2026-07-05'),
        endDate: new Date('2026-08-05'),
        amount: testPlan.price,
        status: 'PENDING',
        createdAt: new Date(),
      };

      expect(() => {
        service.createNextBillingPeriod({
          currentPeriod: pendingPeriod,
          subscription,
          plan: testPlan,
        });
      }).toThrow('Solo se puede generar un nuevo período cuando el período actual está PAID.');
    });
  });

  describe('applyPaymentToBillingPeriod', () => {
    it('debería marcar un período como PAID', () => {
      const period: BillingPeriod = {
        id: 'period_1',
        subscriptionId: 'sub_1',
        periodLabel: 'Julio - Agosto',
        startDate: new Date('2026-07-05'),
        endDate: new Date('2026-08-05'),
        amount: 50,
        status: 'PENDING',
        createdAt: new Date(),
      };

      const paidPeriod = service.applyPaymentToBillingPeriod({
        billingPeriod: period,
        paymentMethod: 'USDT',
        amount: 50,
        paidAt: new Date('2026-07-20'),
        notes: 'Pago recibido',
      });

      expect(paidPeriod.status).toBe('PAID');
      expect(paidPeriod.paymentMethod).toBe('USDT');
      expect(paidPeriod.paidAt).toBeDefined();
    });

    it('debería rechazar si el monto no coincide', () => {
      const period: BillingPeriod = {
        id: 'period_1',
        subscriptionId: 'sub_1',
        periodLabel: 'Julio - Agosto',
        startDate: new Date('2026-07-05'),
        endDate: new Date('2026-08-05'),
        amount: 50,
        status: 'PENDING',
        createdAt: new Date(),
      };

      expect(() => {
        service.applyPaymentToBillingPeriod({
          billingPeriod: period,
          paymentMethod: 'USDT',
          amount: 40,
          paidAt: new Date(),
        });
      }).toThrow('El monto pagado debe ser igual al monto del período.');
    });

    it('debería rechazar si el período ya está PAID', () => {
      const period: BillingPeriod = {
        id: 'period_1',
        subscriptionId: 'sub_1',
        periodLabel: 'Julio - Agosto',
        startDate: new Date('2026-07-05'),
        endDate: new Date('2026-08-05'),
        amount: 50,
        status: 'PAID',
        paidAt: new Date(),
        createdAt: new Date(),
      };

      expect(() => {
        service.applyPaymentToBillingPeriod({
          billingPeriod: period,
          paymentMethod: 'USDT',
          amount: 50,
          paidAt: new Date(),
        });
      }).toThrow('El período ya se encuentra pagado.');
    });
  });

  describe('updateBillingPeriodPaymentData', () => {
    it('debería actualizar todos los campos de un período PAID', () => {
      const period: BillingPeriod = {
        id: 'period_1',
        subscriptionId: 'sub_1',
        periodLabel: 'Julio - Agosto',
        startDate: new Date('2026-07-05'),
        endDate: new Date('2026-08-05'),
        amount: 50,
        status: 'PAID',
        paidAt: new Date('2026-07-10'),
        paymentMethod: 'INITIAL_PAYMENT',
        notes: 'Nota original',
        createdAt: new Date(),
      };

      const updated = service.updateBillingPeriodPaymentData({
        billingPeriod: period,
        paymentMethod: 'CASH',
        amount: 75,
        paidAt: new Date('2026-07-15'),
        notes: 'Nota actualizada',
      });

      expect(updated.status).toBe('PAID');
      expect(updated.paymentMethod).toBe('CASH');
      expect(updated.amount).toBe(75);
      expect(updated.paidAt).toEqual(new Date('2026-07-15'));
      expect(updated.notes).toBe('Nota actualizada');
      expect(updated.id).toBe(period.id);
      expect(updated.subscriptionId).toBe(period.subscriptionId);
      expect(updated.periodLabel).toBe(period.periodLabel);
      expect(updated.startDate).toEqual(period.startDate);
      expect(updated.endDate).toEqual(period.endDate);
    });

    it('debería actualizar solo los campos proporcionados (actualización parcial)', () => {
      const period: BillingPeriod = {
        id: 'period_1',
        subscriptionId: 'sub_1',
        periodLabel: 'Julio - Agosto',
        startDate: new Date('2026-07-05'),
        endDate: new Date('2026-08-05'),
        amount: 50,
        status: 'PAID',
        paidAt: new Date('2026-07-10'),
        paymentMethod: 'INITIAL_PAYMENT',
        notes: 'Nota original',
        createdAt: new Date(),
      };

      const updated = service.updateBillingPeriodPaymentData({
        billingPeriod: period,
        paymentMethod: 'TRANSFER',
      });

      expect(updated.paymentMethod).toBe('TRANSFER');
      expect(updated.amount).toBe(50);
      expect(updated.paidAt).toEqual(new Date('2026-07-10'));
      expect(updated.notes).toBe('Nota original');
    });

    it('debería rechazar actualización de un período PENDING', () => {
      const period: BillingPeriod = {
        id: 'period_1',
        subscriptionId: 'sub_1',
        periodLabel: 'Julio - Agosto',
        startDate: new Date('2026-07-05'),
        endDate: new Date('2026-08-05'),
        amount: 50,
        status: 'PENDING',
        createdAt: new Date(),
      };

      expect(() => {
        service.updateBillingPeriodPaymentData({
          billingPeriod: period,
          paymentMethod: 'CASH',
        });
      }).toThrow('Solo se pueden editar períodos pagados.');
    });

    it('debería rechazar actualización de un período OVERDUE', () => {
      const period: BillingPeriod = {
        id: 'period_1',
        subscriptionId: 'sub_1',
        periodLabel: 'Julio - Agosto',
        startDate: new Date('2026-07-05'),
        endDate: new Date('2026-08-05'),
        amount: 50,
        status: 'OVERDUE',
        createdAt: new Date(),
      };

      expect(() => {
        service.updateBillingPeriodPaymentData({
          billingPeriod: period,
          paymentMethod: 'CASH',
        });
      }).toThrow('Solo se pueden editar períodos pagados.');
    });

    it('debería rechazar monto inválido (<= 0)', () => {
      const period: BillingPeriod = {
        id: 'period_1',
        subscriptionId: 'sub_1',
        periodLabel: 'Julio - Agosto',
        startDate: new Date('2026-07-05'),
        endDate: new Date('2026-08-05'),
        amount: 50,
        status: 'PAID',
        paidAt: new Date('2026-07-10'),
        paymentMethod: 'CASH',
        createdAt: new Date(),
      };

      expect(() => {
        service.updateBillingPeriodPaymentData({
          billingPeriod: period,
          amount: 0,
        });
      }).toThrow('El monto debe ser mayor a cero.');

      expect(() => {
        service.updateBillingPeriodPaymentData({
          billingPeriod: period,
          amount: -10,
        });
      }).toThrow('El monto debe ser mayor a cero.');
    });

    it('debería rechazar método de pago vacío', () => {
      const period: BillingPeriod = {
        id: 'period_1',
        subscriptionId: 'sub_1',
        periodLabel: 'Julio - Agosto',
        startDate: new Date('2026-07-05'),
        endDate: new Date('2026-08-05'),
        amount: 50,
        status: 'PAID',
        paidAt: new Date('2026-07-10'),
        paymentMethod: 'CASH',
        createdAt: new Date(),
      };

      expect(() => {
        service.updateBillingPeriodPaymentData({
          billingPeriod: period,
          paymentMethod: '  ',
        });
      }).toThrow('El método de pago no puede estar vacío.');
    });

    it('debería preservar campos no editables (id, subscriptionId, periodLabel, fechas, createdAt)', () => {
      const createdAt = new Date('2026-07-01');
      const period: BillingPeriod = {
        id: 'period_1',
        subscriptionId: 'sub_1',
        periodLabel: 'Julio - Agosto',
        startDate: new Date('2026-07-05'),
        endDate: new Date('2026-08-05'),
        amount: 50,
        status: 'PAID',
        paidAt: new Date('2026-07-10'),
        paymentMethod: 'INITIAL_PAYMENT',
        createdAt,
      };

      const updated = service.updateBillingPeriodPaymentData({
        billingPeriod: period,
        paymentMethod: 'USDT',
      });

      expect(updated.id).toBe('period_1');
      expect(updated.subscriptionId).toBe('sub_1');
      expect(updated.periodLabel).toBe('Julio - Agosto');
      expect(updated.startDate).toEqual(new Date('2026-07-05'));
      expect(updated.endDate).toEqual(new Date('2026-08-05'));
      expect(updated.createdAt).toEqual(createdAt);
      expect(updated.status).toBe('PAID');
    });
  });

  describe('markPendingPeriodsOverdue', () => {
    it('debería marcar períodos PENDING vencidos como OVERDUE', () => {
      const periods: BillingPeriod[] = [
        {
          id: 'period_1',
          subscriptionId: 'sub_1',
          periodLabel: 'Junio - Julio',
          startDate: new Date('2026-06-05'),
          endDate: new Date('2026-07-05'),
          amount: 50,
          status: 'PENDING',
          createdAt: new Date(),
        },
        {
          id: 'period_2',
          subscriptionId: 'sub_1',
          periodLabel: 'Julio - Agosto',
          startDate: new Date('2026-07-05'),
          endDate: new Date('2026-08-05'),
          amount: 50,
          status: 'PENDING',
          createdAt: new Date(),
        },
      ];

      const referenceDate = new Date('2026-07-10');
      const result = service.markPendingPeriodsOverdue(periods, referenceDate);

      expect(result[0].status).toBe('OVERDUE');
      expect(result[1].status).toBe('PENDING');
    });
  });

  describe('evaluateSubscriptionStatus', () => {
    it('debería suspender suscripción cuando se alcanza maxOverduePeriods', () => {
      const subscription: Subscription = {
        id: 'sub_1',
        clientId: testClient.id,
        planId: testPlan.id,
        kitNumber: 'KIT-001',
        billingDay: 5,
        status: 'ACTIVE',
        maxOverduePeriods: 2,
        createdAt: new Date(),
      };

      const periods: BillingPeriod[] = [
        {
          id: 'period_1',
          subscriptionId: 'sub_1',
          periodLabel: 'Junio - Julio',
          startDate: new Date('2026-06-05'),
          endDate: new Date('2026-07-05'),
          amount: 50,
          status: 'OVERDUE',
          createdAt: new Date(),
        },
        {
          id: 'period_2',
          subscriptionId: 'sub_1',
          periodLabel: 'Julio - Agosto',
          startDate: new Date('2026-07-05'),
          endDate: new Date('2026-08-05'),
          amount: 50,
          status: 'OVERDUE',
          createdAt: new Date(),
        },
      ];

      const result = service.evaluateSubscriptionStatus(subscription, periods);
      expect(result.status).toBe('SUSPENDED');
    });

    it('debería reactivar suscripción cuando se reduce la deuda', () => {
      const subscription: Subscription = {
        id: 'sub_1',
        clientId: testClient.id,
        planId: testPlan.id,
        kitNumber: 'KIT-001',
        billingDay: 5,
        status: 'SUSPENDED',
        maxOverduePeriods: 2,
        createdAt: new Date(),
      };

      const periods: BillingPeriod[] = [
        {
          id: 'period_1',
          subscriptionId: 'sub_1',
          periodLabel: 'Junio - Julio',
          startDate: new Date('2026-06-05'),
          endDate: new Date('2026-07-05'),
          amount: 50,
          status: 'PAID',
          paidAt: new Date(),
          createdAt: new Date(),
        },
        {
          id: 'period_2',
          subscriptionId: 'sub_1',
          periodLabel: 'Julio - Agosto',
          startDate: new Date('2026-07-05'),
          endDate: new Date('2026-08-05'),
          amount: 50,
          status: 'OVERDUE',
          createdAt: new Date(),
        },
      ];

      const result = service.evaluateSubscriptionStatus(subscription, periods);
      expect(result.status).toBe('ACTIVE');
    });
  });
});

describe('Business Rules', () => {
  describe('isValidBillingDay', () => {
    it('debería aceptar días entre 1 y 28', () => {
      expect(isValidBillingDay(1)).toBe(true);
      expect(isValidBillingDay(15)).toBe(true);
      expect(isValidBillingDay(28)).toBe(true);
    });

    it('debería rechazar días fuera del rango', () => {
      expect(isValidBillingDay(0)).toBe(false);
      expect(isValidBillingDay(29)).toBe(false);
      expect(isValidBillingDay(-1)).toBe(false);
    });

    it('debería rechazar valores no enteros', () => {
      expect(isValidBillingDay(5.5)).toBe(false);
      expect(isValidBillingDay(NaN)).toBe(false);
    });
  });

  describe('getBillingPeriodRange', () => {
    it('debería calcular el período correcto cuando la fecha es después del día de corte', () => {
      const referenceDate = new Date('2026-07-20');
      const result = getBillingPeriodRange(referenceDate, 5);

      expect(result.startDate.getDate()).toBe(5);
      expect(result.startDate.getMonth()).toBe(6);
      expect(result.endDate.getDate()).toBe(5);
      expect(result.endDate.getMonth()).toBe(7);
    });

    it('debería calcular el período correcto cuando la fecha es antes del día de corte', () => {
      const referenceDate = new Date('2026-07-03');
      const result = getBillingPeriodRange(referenceDate, 5);

      expect(result.startDate.getDate()).toBe(5);
      expect(result.startDate.getMonth()).toBe(5);
      expect(result.endDate.getDate()).toBe(5);
      expect(result.endDate.getMonth()).toBe(6);
    });
  });
});

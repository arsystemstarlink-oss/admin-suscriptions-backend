import {
  BillingPeriod,
  BillingPeriodStatus,
  BusinessError,
  Plan,
  Subscription,
  SubscriptionStatus,
} from './entities';
import {
  areSameDay,
  buildPeriodLabel,
  createId,
  getBillingPeriodRange,
  isDateAfter,
  isValidBillingDay,
  isValidBillingPeriodStatus,
  isValidSubscriptionStatus,
} from './business-rules';

export interface HistoricalPaymentInput {
  periodLabel: string;
  startDate: Date;
  endDate: Date;
  amount: number;
  paidAt: Date;
  paymentMethod: string;
  notes?: string;
}

export interface SubscriptionSummary {
  totalPeriods: number;
  paidPeriods: number;
  pendingPeriods: number;
  overduePeriods: number;
  totalPaid: number;
  totalPending: number;
}

export class SubscriptionBusinessService {
  createSubscription(params: {
    clientId: string;
    plan: Plan;
    kitNumber: string;
    accountNumber?: string;
    billingDay: number;
    maxOverduePeriods: number;
    registrationDate: Date;
    activationDate?: Date;
    historicalPayments?: HistoricalPaymentInput[];
  }): { subscription: Subscription; billingPeriods: BillingPeriod[]; summary: SubscriptionSummary } {
    const { clientId, plan, kitNumber, accountNumber, billingDay, maxOverduePeriods, registrationDate, activationDate, historicalPayments } = params;

    if (!clientId) {
      throw new BusinessError('INVALID_CLIENT', 'El cliente es obligatorio.');
    }

    if (!plan || !plan.active) {
      throw new BusinessError('INVALID_PLAN', 'El plan debe existir y estar activo.');
    }

    if (!isValidBillingDay(billingDay)) {
      throw new BusinessError('INVALID_BILLING_DAY', 'El día de corte debe ser un número entre 1 y 28.');
    }

    const subscription: Subscription = {
      id: createId(),
      clientId,
      planId: plan.id,
      kitNumber,
      accountNumber,
      billingDay,
      status: 'ACTIVE',
      maxOverduePeriods: maxOverduePeriods < 1 ? 1 : maxOverduePeriods,
      activationDate,
      createdAt: new Date(),
    };

    let billingPeriods: BillingPeriod[];

    if (activationDate) {
      const payments = historicalPayments || [];
      this.validateRetroactiveData(activationDate, payments, plan.price);
      billingPeriods = this.generateRetroactivePeriods(
        subscription.id,
        activationDate,
        billingDay,
        plan.price,
        payments,
        new Date()
      );
      subscription.status = this.evaluateInitialSubscriptionStatus(subscription, billingPeriods);
    } else {
      const { startDate, endDate, periodLabel } = getBillingPeriodRange(registrationDate, billingDay);

      const firstBillingPeriod: BillingPeriod = {
        id: createId(),
        subscriptionId: subscription.id,
        periodLabel,
        startDate,
        endDate,
        amount: plan.price,
        status: 'PAID',
        paidAt: registrationDate,
        paymentMethod: 'INITIAL_PAYMENT',
        notes: 'Primer período registrado como pagado al crear la suscripción.',
        createdAt: new Date(),
      };

      billingPeriods = [firstBillingPeriod];
    }

    const summary = this.calculateSummary(billingPeriods);

    return { subscription, billingPeriods, summary };
  }

  private validateActivationDate(activationDate: Date): void {
    const now = new Date();
    if (isDateAfter(activationDate, now) && !areSameDay(activationDate, now)) {
      throw new BusinessError('INVALID_ACTIVATION_DATE', 'La fecha de activación no puede ser futura.');
    }
  }

  private validateRetroactiveData(activationDate: Date, historicalPayments: HistoricalPaymentInput[], planPrice: number): void {
    const now = new Date();

    this.validateActivationDate(activationDate);

    if (!Array.isArray(historicalPayments)) {
      throw new BusinessError('INVALID_HISTORICAL_PAYMENTS', 'Los pagos históricos deben ser un array.');
    }

    historicalPayments.forEach((payment, index) => {
      if (isDateAfter(payment.paidAt, now) && !areSameDay(payment.paidAt, now)) {
        throw new BusinessError('INVALID_PAYMENT_DATE', `El pago ${index} tiene fecha futura.`);
      }

      if (isDateAfter(activationDate, payment.startDate) && !areSameDay(activationDate, payment.startDate)) {
        throw new BusinessError('INVALID_PERIOD_START', `El período ${index} inicia antes de la activación.`);
      }

      if (!isDateAfter(payment.endDate, payment.startDate)) {
        throw new BusinessError('INVALID_PERIOD_RANGE', `El período ${index} tiene rango inválido.`);
      }

      if (payment.amount !== planPrice) {
        throw new BusinessError('INVALID_AMOUNT', `El pago ${index} tiene monto diferente al precio del plan.`);
      }

      if (payment.paymentMethod === 'INITIAL_PAYMENT') {
        throw new BusinessError('INVALID_PAYMENT_METHOD', `El pago ${index} no puede usar INITIAL_PAYMENT.`);
      }
    });

    const sorted = [...historicalPayments].sort(
      (a, b) => a.startDate.getTime() - b.startDate.getTime()
    );

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];

      if (isDateAfter(prev.endDate, curr.startDate)) {
        throw new BusinessError('OVERLAPPING_PERIODS', 'Los períodos históricos se superponen.');
      }
    }
  }

  private evaluateInitialSubscriptionStatus(subscription: Subscription, billingPeriods: BillingPeriod[]): SubscriptionStatus {
    const overdueCount = billingPeriods.filter((p) => p.status === 'OVERDUE').length;
    return overdueCount >= subscription.maxOverduePeriods ? 'SUSPENDED' : 'ACTIVE';
  }

  private generateRetroactivePeriods(
    subscriptionId: string,
    activationDate: Date,
    billingDay: number,
    planPrice: number,
    historicalPayments: HistoricalPaymentInput[],
    now: Date
  ): BillingPeriod[] {
    const periods: BillingPeriod[] = [];

    const nextMonth = activationDate.getMonth() + 1;
    const nextMonthYear = nextMonth > 11 ? activationDate.getFullYear() + 1 : activationDate.getFullYear();
    const nextMonthNormalized = nextMonth > 11 ? 0 : nextMonth;
    const firstPeriodEnd = new Date(nextMonthYear, nextMonthNormalized, billingDay, 0, 0, 0, 0);

    let periodStart = new Date(activationDate);
    let isFirstPeriod = true;

    while (true) {
      let periodEnd: Date;

      if (isFirstPeriod) {
        periodEnd = firstPeriodEnd;
        isFirstPeriod = false;
      } else {
        periodEnd = new Date(periodStart);
        periodEnd.setMonth(periodEnd.getMonth() + 1);
      }

      const matchingPayment = historicalPayments.find(
        (p) => areSameDay(p.startDate, periodStart)
      );

      let status: BillingPeriodStatus;
      if (matchingPayment) {
        status = 'PAID';
      } else if (isDateAfter(now, periodEnd) || areSameDay(now, periodEnd)) {
        status = 'OVERDUE';
      } else {
        status = 'PENDING';
      }

      periods.push({
        id: createId(),
        subscriptionId,
        periodLabel: buildPeriodLabel(periodStart, periodEnd),
        startDate: periodStart,
        endDate: periodEnd,
        amount: planPrice,
        status,
        paidAt: matchingPayment ? matchingPayment.paidAt : undefined,
        paymentMethod: matchingPayment?.paymentMethod,
        notes: matchingPayment?.notes,
        createdAt: new Date(),
      });

      if (isDateAfter(periodEnd, now)) {
        break;
      }

      periodStart = periodEnd;

      if (periods.length > 120) break;
    }

    return periods;
  }

  private calculateSummary(periods: BillingPeriod[]): SubscriptionSummary {
    const paidPeriods = periods.filter((p) => p.status === 'PAID');
    const pendingPeriods = periods.filter((p) => p.status === 'PENDING');
    const overduePeriods = periods.filter((p) => p.status === 'OVERDUE');

    return {
      totalPeriods: periods.length,
      paidPeriods: paidPeriods.length,
      pendingPeriods: pendingPeriods.length,
      overduePeriods: overduePeriods.length,
      totalPaid: paidPeriods.reduce((sum, p) => sum + p.amount, 0),
      totalPending: [...pendingPeriods, ...overduePeriods].reduce((sum, p) => sum + p.amount, 0),
    };
  }

  changeSubscriptionPlan(subscription: Subscription, newPlan: Plan): Subscription {
    if (!newPlan.active) {
      throw new BusinessError('PLAN_INACTIVE', 'El nuevo plan debe estar activo.');
    }

    return {
      ...subscription,
      planId: newPlan.id,
    };
  }

  createNextBillingPeriod(params: {
    currentPeriod: BillingPeriod;
    subscription: Subscription;
    plan: Plan;
  }): BillingPeriod {
    const { currentPeriod, subscription, plan } = params;

    if (currentPeriod.status !== 'PAID') {
      throw new BusinessError('INVALID_PERIOD_STATE', 'Solo se puede generar un nuevo período cuando el período actual está PAID.');
    }

    const now = new Date();
    if (!isDateAfter(now, currentPeriod.endDate) && !areSameDay(now, currentPeriod.endDate)) {
      throw new BusinessError('PERIOD_NOT_COMPLETE', 'El período actual aún no ha llegado a su fecha de finalización.');
    }

    const nextStartDate = new Date(currentPeriod.endDate);
    const nextEndDate = new Date(nextStartDate);
    nextEndDate.setMonth(nextEndDate.getMonth() + 1);

    return {
      id: createId(),
      subscriptionId: subscription.id,
      periodLabel: buildPeriodLabel(nextStartDate, nextEndDate),
      startDate: nextStartDate,
      endDate: nextEndDate,
      amount: plan.price,
      status: 'PENDING',
      createdAt: now,
    };
  }

  applyPaymentToBillingPeriod(params: {
    billingPeriod: BillingPeriod;
    paymentMethod: string;
    amount: number;
    paidAt: Date;
    notes?: string;
  }): BillingPeriod {
    const { billingPeriod, paymentMethod, amount, paidAt, notes } = params;

    if (billingPeriod.status === 'PAID') {
      throw new BusinessError('PERIOD_ALREADY_PAID', 'El período ya se encuentra pagado.');
    }

    if (amount !== billingPeriod.amount) {
      throw new BusinessError('INVALID_PAYMENT_AMOUNT', 'El monto pagado debe ser igual al monto del período.');
    }

    return {
      ...billingPeriod,
      status: 'PAID',
      paidAt,
      paymentMethod,
      notes,
    };
  }

  updateBillingPeriodPaymentData(params: {
    billingPeriod: BillingPeriod;
    paymentMethod?: string;
    amount?: number;
    paidAt?: Date;
    notes?: string;
  }): BillingPeriod {
    const { billingPeriod, paymentMethod, amount, paidAt, notes } = params;

    if (billingPeriod.status !== 'PAID') {
      throw new BusinessError('INVALID_PERIOD_STATE', 'Solo se pueden editar períodos pagados.');
    }

    if (amount !== undefined && amount <= 0) {
      throw new BusinessError('INVALID_DATA', 'El monto debe ser mayor a cero.');
    }

    if (paymentMethod !== undefined && !paymentMethod.trim()) {
      throw new BusinessError('INVALID_DATA', 'El método de pago no puede estar vacío.');
    }

    return {
      ...billingPeriod,
      paymentMethod: paymentMethod !== undefined ? paymentMethod : billingPeriod.paymentMethod,
      amount: amount !== undefined ? amount : billingPeriod.amount,
      paidAt: paidAt !== undefined ? paidAt : billingPeriod.paidAt,
      notes: notes !== undefined ? notes : billingPeriod.notes,
    };
  }

  markPendingPeriodsOverdue(periods: BillingPeriod[], referenceDate: Date): BillingPeriod[] {
    return periods.map((period) => {
      if (period.status !== 'PENDING') {
        return period;
      }

      if (isDateAfter(referenceDate, period.endDate)) {
        return {
          ...period,
          status: 'OVERDUE',
        };
      }

      return period;
    });
  }

  evaluateSubscriptionStatus(subscription: Subscription, periods: BillingPeriod[]): Subscription {
    const overdueCount = periods.filter((period) => period.status === 'OVERDUE').length;

    if (overdueCount >= subscription.maxOverduePeriods && subscription.status !== 'SUSPENDED') {
      return {
        ...subscription,
        status: 'SUSPENDED',
      };
    }

    if (overdueCount < subscription.maxOverduePeriods && subscription.status === 'SUSPENDED') {
      return {
        ...subscription,
        status: 'ACTIVE',
      };
    }

    return subscription;
  }

  validateSubscription(subscription: Subscription): void {
    if (!subscription.clientId) {
      throw new BusinessError('INVALID_SUBSCRIPTION_CLIENT', 'La suscripción debe pertenecer a un cliente.');
    }

    if (!subscription.planId) {
      throw new BusinessError('INVALID_SUBSCRIPTION_PLAN', 'La suscripción debe tener un plan asignado.');
    }

    if (!isValidBillingDay(subscription.billingDay)) {
      throw new BusinessError('INVALID_SUBSCRIPTION_BILLING_DAY', 'El día de corte de la suscripción es inválido.');
    }

    if (!isValidSubscriptionStatus(subscription.status)) {
      throw new BusinessError('INVALID_SUBSCRIPTION_STATUS', 'El estado de la suscripción es inválido.');
    }
  }

  validateBillingPeriod(billingPeriod: BillingPeriod): void {
    if (!billingPeriod.subscriptionId) {
      throw new BusinessError('INVALID_BILLING_PERIOD_SUBSCRIPTION', 'El período debe pertenecer a una suscripción.');
    }

    if (!isValidBillingPeriodStatus(billingPeriod.status)) {
      throw new BusinessError('INVALID_BILLING_PERIOD_STATUS', 'El estado del período es inválido.');
    }

    if (billingPeriod.amount <= 0) {
      throw new BusinessError('INVALID_BILLING_PERIOD_AMOUNT', 'El monto del período debe ser mayor a cero.');
    }
  }
}

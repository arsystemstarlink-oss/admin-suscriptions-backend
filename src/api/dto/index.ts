export interface CreateClientDto {
  name: string;
  phone: string;
  email?: string;
  address?: string;
  notes?: string;
}

export interface UpdateClientDto {
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
}

export interface CreatePlanDto {
  name: string;
  price: number;
  description: string;
  active?: boolean;
}

export interface UpdatePlanDto {
  name?: string;
  price?: number;
  description?: string;
  active?: boolean;
}

export interface HistoricalPaymentDto {
  periodLabel: string;
  startDate: string;
  endDate: string;
  amount: number;
  paidAt: string;
  paymentMethod: string;
  notes?: string;
}

export interface CreateSubscriptionDto {
  clientId: string;
  planId: string;
  kitNumber: string;
  accountNumber?: string;
  billingDay: number;
  maxOverduePeriods: number;
  activationDate?: string;
  historicalPayments?: HistoricalPaymentDto[];
}

export interface UpdateSubscriptionDto {
  planId?: string;
  kitNumber?: string;
  accountNumber?: string;
  billingDay?: number;
  maxOverduePeriods?: number;
  status?: 'ACTIVE' | 'SUSPENDED';
}

export interface RegisterPaymentDto {
  paymentMethod: string;
  amount: number;
  paidAt: string;
  notes?: string;
}

export interface UpdateBillingPeriodDto {
  paymentMethod?: string;
  amount?: number;
  paidAt?: string;
  notes?: string;
}

export interface SendWhatsAppDto {
  to: string;
  body: string;
}

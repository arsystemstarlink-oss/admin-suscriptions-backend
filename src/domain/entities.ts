export type UserRole = 'admin';
export type SubscriptionStatus = 'ACTIVE' | 'SUSPENDED';
export type BillingPeriodStatus = 'PENDING' | 'PAID' | 'OVERDUE';

export interface User {
  id: string;
  name: string;
  email: string;
  password: string;
  role: UserRole;
  phone?: string;
  lastLoginAt?: Date;
  createdAt: Date;
}

export interface RefreshTokenSession {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date;
  revokedAt?: Date;
  replacedBy?: string;
}

export interface Client {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  email?: string;
  address?: string;
  notes?: string;
  createdAt: Date;
}

export interface Plan {
  id: string;
  name: string;
  price: number;
  description: string;
  active: boolean;
  createdAt: Date;
}

export interface Subscription {
  id: string;
  clientId: string;
  planId: string;
  kitNumber: string;
  accountNumber?: string;
  billingDay: number;
  status: SubscriptionStatus;
  maxOverduePeriods: number;
  activationDate?: Date;
  createdAt: Date;
}

export interface BillingPeriod {
  id: string;
  subscriptionId: string;
  periodLabel: string;
  startDate: Date;
  endDate: Date;
  amount: number;
  status: BillingPeriodStatus;
  paidAt?: Date;
  paymentMethod?: string;
  notes?: string;
  createdAt: Date;
}

export interface SchedulerConfig {
  id: string;
  enabled: boolean;
  cronSchedule: string;
  lastRun?: Date;
  updatedAt: Date;
}

export type MessageDirection = 'INBOUND' | 'OUTBOUND';
export type MessageStatus = 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

export interface WhatsAppMessage {
  id: string;
  clientId?: string;
  phone: string;
  direction: MessageDirection;
  messageSid: string;
  body: string;
  templateName?: string;
  status: MessageStatus;
  errorMessage?: string;
  profileName?: string;
  createdAt: Date;
}

export class BusinessError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    Object.setPrototypeOf(this, BusinessError.prototype);
  }
}

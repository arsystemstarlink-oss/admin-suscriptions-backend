export type UserRole = 'super-admin' | 'admin';
export type SubscriptionStatus = 'ACTIVE' | 'SUSPENDED';
export type BillingPeriodStatus = 'PENDING' | 'PAID' | 'OVERDUE';

export interface OrganizationTwilioConfig {
  accountSid?: string;
  authToken?: string;
  phoneNumber?: string;
  enabled?: boolean;
}

export interface Organization {
  id: string;
  name: string;
  slug?: string;
  active: boolean;
  twilio?: OrganizationTwilioConfig;
  createdAt: Date;
  createdBy?: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  password: string;
  role: UserRole;
  organizationId: string | null;
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
  organizationId: string;
  firstName: string;
  lastName: string;
  phone: string;
  dni?: string;
  email?: string;
  address?: string;
  notes?: string;
  createdAt: Date;
  createdByUserId?: string;
  createdByRole?: UserRole;
}

export interface Plan {
  id: string;
  organizationId: string;
  name: string;
  price: number;
  description: string;
  active: boolean;
  createdAt: Date;
  createdByUserId?: string;
  createdByRole?: UserRole;
}

export interface Subscription {
  id: string;
  organizationId: string;
  clientId: string;
  planId: string;
  kitNumber: string;
  accountNumber?: string;
  billingDay: number;
  status: SubscriptionStatus;
  maxOverduePeriods: number;
  activationDate?: Date;
  createdAt: Date;
  createdByUserId?: string;
  createdByRole?: UserRole;
}

export interface BillingPeriod {
  id: string;
  organizationId: string;
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
  organizationId?: string;
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

export interface WhatsAppConversation {
  phone: string;
  clientId?: string;
  profileName?: string;
  lastMessage: WhatsAppMessage;
  messageCount: number;
}

export interface PushSubscription {
  id: string;
  organizationId: string;
  adminId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type DomainEventType =
  | 'client.created'
  | 'subscription.created'
  | 'subscription.suspended'
  | 'subscription.reactivated'
  | 'subscription.plan_changed'
  | 'billing_period.overdue'
  | 'billing_period.paid'
  | 'billing_period.generated';

export interface DomainEvent {
  id: string;
  type: DomainEventType;
  organizationId: string;
  actorUserId?: string;
  entity: string;
  entityId: string;
  payload?: Record<string, unknown>;
  createdAt: Date;
}

export class BusinessError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    Object.setPrototypeOf(this, BusinessError.prototype);
  }
}

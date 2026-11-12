jest.mock('web-push', () => ({
  __esModule: true,
  default: {
    setVapidDetails: jest.fn(),
    sendNotification: jest.fn(),
  },
}));

jest.mock('../infrastructure/repositories', () => ({
  pushSubscriptionRepository: {
    upsertByEndpoint: jest.fn(),
    listByAdminId: jest.fn(),
    listByAdminIds: jest.fn(),
    findByEndpoint: jest.fn(),
    delete: jest.fn(),
  },
  userRepository: {
    list: jest.fn(),
    listByOrganization: jest.fn(),
  },
}));

import webpush from 'web-push';
import { pushService } from '../infrastructure/push-service';
import { pushSubscriptionRepository } from '../infrastructure/repositories';

const mockedWebPush = webpush as jest.Mocked<typeof webpush>;
const mockedSubscriptions = pushSubscriptionRepository as jest.Mocked<typeof pushSubscriptionRepository>;

const subscription = {
  id: 'push_1',
  organizationId: 'org_1',
  adminId: 'admin_1',
  endpoint: 'https://push.example/1',
  p256dh: 'p256dh',
  auth: 'auth',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('PushService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VAPID_PUBLIC_KEY = 'public';
    process.env.VAPID_PRIVATE_KEY = 'private';
    process.env.VAPID_SUBJECT = 'mailto:test@example.com';
  });

  afterAll(() => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
  });

  it('registra la suscripción con el administrador y organización autenticados', async () => {
    mockedSubscriptions.upsertByEndpoint.mockResolvedValue(subscription);

    await pushService.registerSubscription('admin_1', 'org_1', {
      endpoint: subscription.endpoint,
      keys: { p256dh: 'new-p256dh', auth: 'new-auth' },
      userAgent: 'browser',
    });

    expect(mockedSubscriptions.upsertByEndpoint).toHaveBeenCalledWith(
      subscription.endpoint,
      expect.objectContaining({ adminId: 'admin_1', organizationId: 'org_1' })
    );
  });

  it('no cuenta como enviado un endpoint expirado y lo elimina', async () => {
    mockedSubscriptions.listByAdminIds.mockResolvedValue([subscription]);
    mockedWebPush.sendNotification.mockRejectedValue({ statusCode: 410 });

    const sent = await pushService.sendToAdmins(['admin_1'], {
      title: 'Título',
      body: 'Mensaje',
    }, 'org_1');

    expect(sent).toBe(0);
    expect(mockedSubscriptions.delete).toHaveBeenCalledWith(subscription.id);
    expect(mockedSubscriptions.listByAdminIds).toHaveBeenCalledWith(['admin_1'], 'org_1');
  });

  it('reintenta con backoff cuando el proveedor responde 429', async () => {
    mockedSubscriptions.listByAdminIds.mockResolvedValue([subscription]);
    mockedWebPush.sendNotification
      .mockRejectedValueOnce({ statusCode: 429 })
      .mockResolvedValueOnce({ statusCode: 201 } as never);

    const sent = await pushService.sendToAdmins(['admin_1'], {
      title: 'Título',
      body: 'Mensaje',
    });

    expect(sent).toBe(1);
    expect(mockedWebPush.sendNotification).toHaveBeenCalledTimes(2);
  });
});

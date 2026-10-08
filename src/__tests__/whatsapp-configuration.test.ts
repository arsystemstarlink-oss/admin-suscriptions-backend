import { Organization } from '../domain/entities';
import {
  getWhatsAppConfigurationReadiness,
  resolveWhatsAppNotificationConfig,
} from '../infrastructure/whatsapp-configuration';

describe('WhatsApp configuration by organization', () => {
  it('preserves the existing defaults when an organization has no saved notification config', () => {
    const organization: Organization = {
      id: 'org_A',
      name: 'Org A',
      active: true,
      createdAt: new Date(),
    };

    const config = resolveWhatsAppNotificationConfig(organization);

    expect(config.rules).toEqual({
      reminderDaysBefore: [3],
      dueDateWarningEnabled: true,
      suspensionNoticeEnabled: true,
    });
    expect(getWhatsAppConfigurationReadiness(organization, config).usingLegacyTemplates).toBe(true);
  });

  it('reports a ready organization when credentials and enabled templates are configured', () => {
    const organization: Organization = {
      id: 'org_A',
      name: 'Org A',
      active: true,
      twilio: {
        accountSid: 'AC_org_A',
        authToken: 'secret',
        phoneNumber: '+584111111111',
      },
      whatsappNotifications: {
        rules: {
          reminderDaysBefore: [5, 3],
          dueDateWarningEnabled: true,
          suspensionNoticeEnabled: true,
        },
        templates: {
          reminder: 'HX_reminder',
          dueDateWarning: 'HX_due',
          suspensionNotice: 'HX_suspension',
        },
      },
      createdAt: new Date(),
    };

    expect(getWhatsAppConfigurationReadiness(organization)).toEqual({
      ready: true,
      missing: [],
      usingLegacyTemplates: false,
    });
  });

  it('does not require templates for disabled notification rules', () => {
    const organization: Organization = {
      id: 'org_A',
      name: 'Org A',
      active: true,
      twilio: {
        accountSid: 'AC_org_A',
        authToken: 'secret',
        phoneNumber: '+584111111111',
      },
      whatsappNotifications: {
        rules: {
          reminderDaysBefore: [],
          dueDateWarningEnabled: false,
          suspensionNoticeEnabled: false,
        },
        templates: {},
      },
      createdAt: new Date(),
    };

    expect(getWhatsAppConfigurationReadiness(organization).ready).toBe(true);
  });
});

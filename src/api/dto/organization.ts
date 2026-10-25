import { Organization } from '../../domain/entities';
import { getOrganizationBillingDay } from '../../domain/business-plan';

export function toOrganizationDto(organization: Organization) {
  const { twilio, planUpdatedBy: _planUpdatedBy, ...rest } = organization;

  return {
    ...rest,
    billingDay: getOrganizationBillingDay(organization),
    twilioConfigured: Boolean(
      twilio?.accountSid &&
        twilio?.authToken &&
        twilio?.phoneNumber &&
        twilio.enabled !== false
    ),
    twilio: twilio
      ? {
          accountSid: twilio.accountSid,
          phoneNumber: twilio.phoneNumber,
          enabled: twilio.enabled !== false,
          authTokenSet: Boolean(twilio.authToken),
        }
      : undefined,
  };
}

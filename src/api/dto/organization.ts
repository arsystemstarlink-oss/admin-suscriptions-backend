import { Organization } from '../../domain/entities';

export function toOrganizationDto(organization: Organization) {
  const { twilio, planUpdatedBy: _planUpdatedBy, ...rest } = organization;

  return {
    ...rest,
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

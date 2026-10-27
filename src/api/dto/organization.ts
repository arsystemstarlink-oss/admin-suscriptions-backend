import { Organization } from '../../domain/entities';
import { getOrganizationBillingDay, resolveEffectiveClientLimit } from '../../domain/business-plan';

export function toOrganizationDto(organization: Organization) {
  const { twilio, planUpdatedBy: _planUpdatedBy, ...rest } = organization;
  const effectiveClientLimit = resolveEffectiveClientLimit(organization.plan, organization.clientLimit);

  return {
    ...rest,
    billingDay: getOrganizationBillingDay(organization),
    clientLimit: effectiveClientLimit ?? organization.clientLimit,
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

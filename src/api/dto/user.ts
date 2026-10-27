import { BusinessError, User } from '../../domain/entities';
import { organizationRepository } from '../../infrastructure/repositories';
import { toOrganizationDto } from './organization';

export function toUserDto(user: User) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    organizationId: user.organizationId,
    lastLoginAt: user.lastLoginAt,
    mustChangePassword: user.mustChangePassword === true,
    createdAt: user.createdAt,
  };
}

export async function toAuthenticatedUserDto(user: User) {
  const userDto = toUserDto(user);
  if (user.role !== 'admin' || !user.organizationId) {
    return userDto;
  }
  const organization = await organizationRepository.getById(user.organizationId);
  if (!organization) {
    throw new BusinessError('ORGANIZATION_NOT_FOUND', 'La organización del usuario no existe.');
  }
  const currentOrganization = await organizationRepository.refreshExpiredStatus(organization);
  return { ...userDto, organization: toOrganizationDto(currentOrganization) };
}

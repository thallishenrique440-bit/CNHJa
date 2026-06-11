import { ProviderName } from './types';

/**
 * PaymentProviderResolver
 *
 * This layer is responsible for determining which payment gateway should be selected.
 * In this initial architectural layout phase, all lookup strategies resolve to the
 * environment-configured gatekeeper variable DEFAULT_PAYMENT_PROVIDER, or fall back to 'stripe'.
 *
 * This class is designed to be pure—meaning it acts as a structured contract point and
 * has zero dependencies on databases (like PostgreSQL/Supabase), direct session lookups,
 * or UI components.
 */
export class PaymentProviderResolver {
  /**
   * Resolves the default payment provider configured in environment coordinates.
   *
   * @returns The resolved ProviderName ('stripe' or 'asaas')
   */
  static resolveDefaultProvider(): ProviderName {
    const defaultProvider = process.env.DEFAULT_PAYMENT_PROVIDER;
    if (defaultProvider === 'asaas' || defaultProvider === 'stripe') {
      return defaultProvider;
    }
    return 'stripe';
  }

  /**
   * Resolves the provider to be used for a specific instructor.
   * Currently routes dynamically to the default environment provider.
   *
   * @param instructorId The unique identifier of the instructor
   * @returns The resolved ProviderName ('stripe' or 'asaas')
   */
  static resolveProviderForInstructor(instructorId: string): ProviderName {
    if (!instructorId) {
      throw new Error('instructorId is required to resolve payment provider');
    }
    return this.resolveDefaultProvider();
  }

  /**
   * Resolves the provider to be used for a specific student.
   * Currently routes dynamically to the default environment provider.
   *
   * @param studentId The unique identifier of the student
   * @returns The resolved ProviderName ('stripe' or 'asaas')
   */
  static resolveProviderForStudent(studentId: string): ProviderName {
    if (!studentId) {
      throw new Error('studentId is required to resolve payment provider');
    }
    return this.resolveDefaultProvider();
  }

  /**
   * Resolves the provider to be used for a specific reservation (appointment).
   * Currently routes dynamically to the default environment provider.
   *
   * @param appointmentId The unique identifier of the appointment
   * @returns The resolved ProviderName ('stripe' or 'asaas')
   */
  static resolveProviderForAppointment(appointmentId: string): ProviderName {
    if (!appointmentId) {
      throw new Error('appointmentId is required to resolve payment provider');
    }
    return this.resolveDefaultProvider();
  }
}

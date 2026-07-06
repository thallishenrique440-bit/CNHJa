import { ProviderName } from './types.js';

/**
 * PaymentProviderResolver
 *
 * This layer is responsible for determining which payment gateway should be selected.
 * Configured exclusively to resolve to 'asaas'.
 */
export class PaymentProviderResolver {
  /**
   * Resolves the default payment provider.
   *
   * @returns Always 'asaas'
   */
  static resolveDefaultProvider(): ProviderName {
    return 'asaas';
  }

  /**
   * Resolves the provider to be used for a specific instructor.
   *
   * @param instructorId The unique identifier of the instructor
   * @returns Always 'asaas'
   */
  static resolveProviderForInstructor(instructorId: string): ProviderName {
    if (!instructorId) {
      throw new Error('instructorId is required to resolve payment provider');
    }
    return 'asaas';
  }

  /**
   * Resolves the provider to be used for a specific student.
   *
   * @param studentId The unique identifier of the student
   * @returns Always 'asaas'
   */
  static resolveProviderForStudent(studentId: string): ProviderName {
    if (!studentId) {
      throw new Error('studentId is required to resolve payment provider');
    }
    return 'asaas';
  }

  /**
   * Resolves the provider to be used for a specific reservation (appointment).
   *
   * @param appointmentId The unique identifier of the appointment
   * @returns Always 'asaas'
   */
  static resolveProviderForAppointment(appointmentId: string): ProviderName {
    if (!appointmentId) {
      throw new Error('appointmentId is required to resolve payment provider');
    }
    return 'asaas';
  }
}


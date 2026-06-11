import { IPaymentProvider } from './IPaymentProvider';
import { StripeProvider } from './StripeProvider';
import { AsaasProvider } from './AsaasProvider';
import { ProviderName } from './types';

/**
 * PaymentProviderFactory
 *
 * Factory responsible for selecting and instantiating the appropriate payment provider.
 * Follows strict architectural isolation rules: contains no business logic, no database layers,
 * and no client/frontend state. It simply instantiates and returns the requested provider object.
 */
export class PaymentProviderFactory {
  /**
   * Retrieves the requested payment provider instance.
   *
   * @param providerName The identifier of the payment gateway ('stripe' or 'asaas')
   * @returns An implementation of the IPaymentProvider interface
   */
  static getProvider(providerName: ProviderName): IPaymentProvider {
    switch (providerName) {
      case 'stripe':
        return new StripeProvider();
      case 'asaas':
        return new AsaasProvider();
      default: {
        const exhaustiveCheck: never = providerName;
        throw new Error(`Unsupported payment provider: ${exhaustiveCheck}`);
      }
    }
  }
}

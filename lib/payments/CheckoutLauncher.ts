/**
 * CheckoutLauncher (CNHJÁ)
 * 
 * Layer responsible for opening external checkouts safely and compatibly 
 * across Web, Mobile, and Standalone PWA environments.
 * Extensible for any payment gateway (Asaas, etc.).
 */

export interface LaunchOptions {
  /**
   * Whether to force opening the URL in a new tab/system browser.
   * If false, it will auto-detect the environment (e.g., will open in new tab if PWA standalone).
   */
  forceNewTab?: boolean;
  
  /**
   * Callback fired when a redirect or new tab opening is successfully initiated.
   */
  onSuccess?: () => void;
  
  /**
   * Callback fired when an error occurs during checkout initiation.
   */
  onError?: (error: Error) => void;
}

interface NavigatorWithStandalone extends Navigator {
  standalone?: boolean;
}

export class CheckoutLauncher {

  /**
   * Detects if the current application context is running inside a Standalone PWA
   * (either pinned to iOS Home Screen, Android TWA, or desktop standalone shortcut).
   */
  static isStandalone(): boolean {
    if (typeof window === 'undefined') return false;

    const isStandaloneMedia = window.matchMedia('(display-mode: standalone)').matches;
    const isNavigatorStandalone = !!(window.navigator as NavigatorWithStandalone).standalone;
    const isAndroidTWA = document.referrer.includes('android-app://');

    return isStandaloneMedia || isNavigatorStandalone || isAndroidTWA;
  }

  /**
   * Launches an external checkout URL using the optimal method for the environment.
   * - Desktop & Standard Mobile Browsers: Standard redirection via window.location.href.
   * - Standalone PWA: Opens the system's default browser via window.open/anchor target="_blank"
   *   to prevent being trapped inside the PWA WebView (where payment flows might fail).
   * 
   * @param url The external payment or checkout URL.
   * @param options Configuration options and callbacks.
   * @returns boolean True if the launch was successfully initiated, false otherwise.
   */
  static launch(url: string, options: LaunchOptions = {}): boolean {
    if (!url) {
      const error = new Error('Checkout URL is empty or undefined');
      options.onError?.(error);
      return false;
    }

    console.group('[CheckoutLauncher] launch');
    console.log({
      timestamp: Date.now(),
      url,
      options,
      currentUrl: typeof window !== 'undefined' ? window.location.href : ''
    });
    console.trace();
    console.groupEnd();

    try {
      console.log('[CheckoutLauncher] redirecionando na mesma janela via window.location.href');
      window.location.href = url;
      options.onSuccess?.();
      return true;
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      console.error('[CheckoutLauncher] Redirection failed:', error);
      options.onError?.(error);
      return false;
    }
  }
}

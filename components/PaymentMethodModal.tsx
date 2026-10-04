import React, { useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';
import { supabase } from '../lib/supabase';
import {
  GATEWAY_FEE_SELECT,
  GATEWAY_FEE_TABLE,
  GatewayFeeRule,
  mapGatewayFeeRows,
  quoteCheckout
} from '../lib/payments/GatewayFeeModel';

/**
 * Modal "Forma de Pagamento" (PIX + parcelamento).
 *
 * FASE 4: movido SEM alteracao visual de pages/student/InstructorProfile.tsx.
 * No novo fluxo o pagamento acontece depois do aceite do instrutor, em
 * "Minhas Aulas"; o modal, as taxas (P-1.16A, mesma fonte lida pelo backend) e o
 * calculo do total sao os mesmos de antes. O valor efetivamente cobrado e'
 * sempre recalculado no servidor.
 */
export const MAX_INSTALLMENTS = 4;

const formatCurrency = (value: number) =>
  (value / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Tabela de tarifas do gateway (mesma leitura que existia na tela do instrutor). */
export function useGatewayFeeRules(): GatewayFeeRule[] {
  const [gatewayFeeRules, setGatewayFeeRules] = useState<GatewayFeeRule[]>([]);
  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const { data, error } = await supabase
          .from(GATEWAY_FEE_TABLE)
          .select(GATEWAY_FEE_SELECT)
          .eq('provider', 'asaas')
          .is('effective_to', null);
        if (error) {
          console.error('Error fetching gateway fee schedule:', error.message);
          return;
        }
        setGatewayFeeRules(mapGatewayFeeRows(data));
      } catch (err) {
        console.error('Error fetching gateway fee schedule:', err);
      }
    };
    fetchSettings();
  }, []);
  return gatewayFeeRules;
}

interface PaymentMethodModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Quantidade de aulas cobradas (o grupo inteiro). */
  lessonCount: number;
  /** Valor do servico em centavos (soma das aulas, ja' com desconto). */
  servicePriceCents: number;
  isProcessing: boolean;
  onConfirm: (method: 'PIX' | 'CREDIT_CARD', installments: number) => void;
}

export const PaymentMethodModal: React.FC<PaymentMethodModalProps> = ({
  isOpen, onClose, lessonCount, servicePriceCents, isProcessing, onConfirm,
}) => {
  const gatewayFeeRules = useGatewayFeeRules();
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<'PIX' | 'CREDIT_CARD'>('CREDIT_CARD');
  const [selectedInstallmentCount, setSelectedInstallmentCount] = useState<number>(1);
  const totalPrice = servicePriceCents;

  const feeInfo = useMemo(() => {
    const quote = quoteCheckout({
      servicePriceCents: totalPrice,
      method: selectedPaymentMethod === 'CREDIT_CARD' ? 'CREDIT_CARD' : 'PIX',
      installmentCount: selectedInstallmentCount,
      rules: gatewayFeeRules
    });
    return {
      fee: quote.gatewayFeeExpectedCents,
      totalWithFee: quote.studentChargeCents,
      quote
    };
  }, [totalPrice, selectedPaymentMethod, selectedInstallmentCount, gatewayFeeRules]);

  return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Forma de Pagamento"
      >
        <div className="space-y-6">
          <p className="text-sm text-gray-500 leading-relaxed">
            Escolha como prefere realizar o pagamento do seu agendamento de aulas.
          </p>

          <div className="space-y-3">
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider">
              Selecione a opção
            </label>

            <div className="grid grid-cols-2 gap-4">
              <button
                type="button"
                id="payment-method-pix"
                aria-label="Pagamento via Pix"
                onClick={() => {
                  setSelectedPaymentMethod('PIX');
                  setSelectedInstallmentCount(1);
                }}
                className={`flex flex-col items-center justify-center p-4 rounded-xl border-2 transition-all cursor-pointer ${
                  selectedPaymentMethod === 'PIX'
                    ? 'border-blue-600 bg-blue-50/50 text-blue-900 font-semibold'
                    : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                }`}
              >
                <img
                  src="https://ohftsqsxymtrclnpadam.supabase.co/storage/v1/object/public/assets/bdcee2f4-04a4-4475-af95-6ac93d64bbde/PIX.png"
                  alt="Pix Logo"
                  className="h-10 w-auto object-contain mb-1"
                  referrerPolicy="no-referrer"
                />
                <span className="text-sm font-medium">PIX</span>
              </button>

              <button
                type="button"
                id="payment-method-cc"
                onClick={() => setSelectedPaymentMethod('CREDIT_CARD')}
                className={`flex flex-col items-center justify-center p-4 rounded-xl border-2 transition-all cursor-pointer ${
                  selectedPaymentMethod === 'CREDIT_CARD'
                    ? 'border-blue-600 bg-blue-50/50 text-blue-900 font-semibold'
                    : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                }`}
              >
                <span className="text-2xl mb-1">💳</span>
                <span className="text-sm font-medium">Cartão de Crédito</span>
              </button>
            </div>
          </div>

          {selectedPaymentMethod === 'CREDIT_CARD' && (
            <div className="space-y-3">
              <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Parcelamento
              </label>

              <div className="relative">
                <select
                  id="payment-installments-select"
                  value={selectedInstallmentCount}
                  onChange={(e) => setSelectedInstallmentCount(Number(e.target.value))}
                  className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all cursor-pointer appearance-none text-sm font-medium"
                >
                  {Array.from({ length: MAX_INSTALLMENTS }, (_, i) => i + 1).map((count) => {
                    const optionQuote = quoteCheckout({
                      servicePriceCents: totalPrice,
                      method: 'CREDIT_CARD',
                      installmentCount: count,
                      rules: gatewayFeeRules
                    });
                    const percentage = optionQuote.rule ? optionQuote.rule.percent : 0;
                    const installmentValue = optionQuote.studentChargeCents / count;
                    return (
                      <option key={count} value={count}>
                        {count}x de {formatCurrency(installmentValue)} (com taxa de {percentage}%)
                      </option>
                    );
                  })}
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-4 text-gray-500">
                  <svg className="fill-current h-4 w-4" viewBox="0 0 20 20">
                    <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z" />
                  </svg>
                </div>
              </div>
            </div>
          )}

          {/* Checkout Info Box */}
          <div className="bg-gray-50 border border-gray-100 rounded-2xl p-4 space-y-2">
            <div className="flex justify-between text-xs text-gray-500">
              <span>Quantidade de aulas:</span>
              <span className="font-semibold text-gray-700">{lessonCount} aula(s)</span>
            </div>
            <div className="flex justify-between text-xs text-gray-500 pt-1 border-t border-gray-100 font-medium">
              <span>Valor das aulas:</span>
              <span>{formatCurrency(totalPrice)}</span>
            </div>
            <div className="flex justify-between text-xs text-gray-500">
              <span>Taxa de processamento ({selectedPaymentMethod === 'PIX' ? 'PIX' : `Cartão ${selectedInstallmentCount}x`}):</span>
              <span className="font-semibold text-gray-700">{formatCurrency(feeInfo.fee)}</span>
            </div>
            <div className="flex justify-between text-sm pt-2 border-t border-gray-200">
              <span className="font-bold text-gray-900">Total a pagar:</span>
              <span className="font-extrabold text-blue-700 text-base">{formatCurrency(feeInfo.totalWithFee)}</span>
            </div>
            {selectedPaymentMethod === 'CREDIT_CARD' && (
              <div className="flex justify-between text-xs text-blue-600 font-medium pt-1">
                <span>Plano de parcelamento:</span>
                <span>{selectedInstallmentCount}x de {formatCurrency(feeInfo.totalWithFee / selectedInstallmentCount)}</span>
              </div>
            )}
          </div>

          <div className="pt-2 space-y-2">
            <Button
              fullWidth
              id="confirm-payment-btn"
              loading={isProcessing}
              disabled={isProcessing}
              onClick={() => onConfirm(selectedPaymentMethod, selectedInstallmentCount)}
            >
              Confirmar e Pagar
            </Button>
            <button
              type="button"
              id="cancel-payment-btn"
              disabled={isProcessing}
              onClick={onClose}
              className="w-full text-center text-sm font-medium text-gray-400 hover:text-gray-600 py-2 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Voltar
            </button>
          </div>
        </div>
      </Modal>
  );
};

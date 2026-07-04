import React from 'react';

interface AsaasPartnerSealProps {
  className?: string;
}

export const AsaasPartnerSeal: React.FC<AsaasPartnerSealProps> = ({ className = "" }) => {
  return (
    <div className={`flex flex-col items-center justify-center text-center ${className}`}>
      <img 
        src="https://baas.asaas.com/selos/Servicos_financeiros_Asaas-Reduzida-Positivo.svg?id=5cc2e292-aad6-430a-bf08-2130b74d4dd5"
        alt="Selo de Serviços Financeiros Asaas"
        referrerPolicy="no-referrer"
        className="w-[110px] h-auto object-contain object-center block"
      />
      <span className="text-[9px] font-medium tracking-wide text-gray-400 mt-1 max-w-[150px] leading-tight block">
        Serviços financeiros prestados pelo Asaas Gestão Financeira S.A.
      </span>
    </div>
  );
};

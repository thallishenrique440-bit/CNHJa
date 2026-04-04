import React from 'react';
import { Modal } from './Modal';
import { Button } from './Button';

interface TermsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAccept: () => void;
}

export const TermsModal: React.FC<TermsModalProps> = ({ isOpen, onClose, onAccept }) => {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Termos de Uso (Resumo Rápido)"
      footer={
        <div className="flex flex-col sm:flex-row gap-3 w-full">
          <Button 
            fullWidth 
            variant="outline" 
            onClick={onClose}
            className="py-3 text-sm"
          >
            Fechar
          </Button>
          <Button 
            fullWidth 
            onClick={() => {
              onAccept();
              onClose();
            }}
            className="py-3 text-sm shadow-lg shadow-blue-200"
          >
            Aceitar e continuar
          </Button>
        </div>
      }
    >
      <div className="max-h-[60vh] overflow-y-auto pr-2 space-y-6 text-sm text-gray-600 leading-relaxed custom-scrollbar">
        
        <div className="space-y-2">
          <h3 className="font-bold text-gray-900 flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-blue-600 rounded-full"></span>
            O que somos
          </h3>
          <p>
            Somos um marketplace que conecta você a instrutores independentes. Facilitamos o agendamento e o pagamento.
          </p>
        </div>

        <div className="space-y-2">
          <h3 className="font-bold text-gray-900 flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-blue-600 rounded-full"></span>
            Sem Garantia de Aprovação
          </h3>
          <p>
            A plataforma é uma ferramenta de auxílio ao aprendizado. <strong>Não garantimos a sua aprovação nos exames da CNH.</strong>
          </p>
        </div>

        <div className="space-y-2">
          <h3 className="font-bold text-gray-900 flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-blue-600 rounded-full"></span>
            Responsabilidade Limitada
          </h3>
          <p>
            O instrutor é o responsável direto pela aula e pelo veículo. <strong>A plataforma não se responsabiliza por acidentes, danos ou conflitos entre as partes.</strong>
          </p>
        </div>

        <div className="space-y-2">
          <h3 className="font-bold text-gray-900 flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-blue-600 rounded-full"></span>
            Pagamentos Seguros
          </h3>
          <p>
            Usamos a Stripe para processar seus pagamentos com total segurança.
          </p>
        </div>

        <div className="space-y-2">
          <h3 className="font-bold text-gray-900 flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-blue-600 rounded-full"></span>
            Compromisso e Faltas
          </h3>
          <p>
            Fique atento ao horário. Cancelamentos com menos de 24h ou faltas não dão direito a reembolso.
          </p>
        </div>

        <div className="space-y-2">
          <h3 className="font-bold text-gray-900 flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-blue-600 rounded-full"></span>
            Segurança
          </h3>
          <p>
            Você pode compartilhar sua localização em tempo real pelo app durante a aula para sua segurança pessoal.
          </p>
        </div>

        <div className="space-y-2">
          <h3 className="font-bold text-gray-900 flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-blue-600 rounded-full"></span>
            Respeito Mútuo
          </h3>
          <p>
            Não toleramos desrespeito. Avalie com honestidade e mantenha a conduta ética.
          </p>
        </div>

        <div className="space-y-2">
          <h3 className="font-bold text-gray-900 flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-blue-600 rounded-full"></span>
            Leis Brasileiras
          </h3>
          <p>
            Este serviço e seus termos seguem rigorosamente a legislação do Brasil.
          </p>
        </div>

        <div className="pt-4 flex justify-center">
          <a 
            href="/#/terms" 
            target="_blank" 
            rel="noopener noreferrer"
            className="text-blue-600 font-bold hover:underline flex items-center gap-1.5"
          >
            Ver versão completa dos Termos de Uso
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        </div>

        <div className="pt-4 border-t border-gray-100 italic text-xs text-gray-400">
          Ao clicar em "Aceitar", você confirma que leu e concorda com a <strong>versão completa</strong> dos nossos Termos de Uso e Política de Privacidade.
        </div>

      </div>
    </Modal>
  );
};

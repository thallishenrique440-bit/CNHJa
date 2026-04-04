import React from 'react';
import { Modal } from './Modal';
import { Button } from './Button';

interface PrivacyModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAccept: () => void;
}

export const PrivacyModal: React.FC<PrivacyModalProps> = ({ isOpen, onClose, onAccept }) => {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Política de Privacidade (Resumo Rápido)"
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
            O que coletamos
          </h3>
          <p>
            Coletamos dados básicos como seu nome, e-mail, WhatsApp e cidade para criar seu perfil e permitir que você agende suas aulas com segurança.
          </p>
        </div>

        <div className="space-y-2">
          <h3 className="font-bold text-gray-900 flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-blue-600 rounded-full"></span>
            Como usamos seus dados
          </h3>
          <p>
            Suas informações são usadas para gerenciar seus agendamentos, processar pagamentos e garantir que você tenha a melhor experiência de aprendizado possível.
          </p>
        </div>

        <div className="space-y-2">
          <h3 className="font-bold text-gray-900 flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-blue-600 rounded-full"></span>
            Compartilhamento com Instrutores
          </h3>
          <p>
            Para facilitar a aula, compartilhamos seu nome e WhatsApp com o instrutor escolhido <strong>somente após a confirmação do agendamento</strong>. O instrutor passa a ser responsável pelo uso adequado dessas informações.
          </p>
        </div>

        <div className="space-y-2">
          <h3 className="font-bold text-gray-900 flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-blue-600 rounded-full"></span>
            Pagamentos Seguros (Stripe)
          </h3>
          <p>
            Seus pagamentos são processados pela Stripe, líder mundial em segurança. <strong>Nós não temos acesso e não armazenamos os dados do seu cartão</strong> em nossos sistemas.
          </p>
        </div>

        <div className="space-y-2">
          <h3 className="font-bold text-gray-900 flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-blue-600 rounded-full"></span>
            Seus Direitos (LGPD)
          </h3>
          <p>
            Você tem total controle sobre seus dados. Pode acessar, corrigir ou solicitar a exclusão de suas informações a qualquer momento através das configurações do seu perfil.
          </p>
        </div>

        <div className="space-y-2">
          <h3 className="font-bold text-gray-900 flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-blue-600 rounded-full"></span>
            Segurança em Primeiro Lugar
          </h3>
          <p>
            Protegemos seus dados com criptografia e tecnologias modernas para garantir que suas informações pessoais estejam sempre seguras e privadas.
          </p>
        </div>

        <div className="space-y-2">
          <h3 className="font-bold text-gray-900 flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-blue-600 rounded-full"></span>
            Transparência Total
          </h3>
          <p>
            Não vendemos seus dados para terceiros. O uso das informações é estritamente operacional, focado em conectar você ao instrutor e melhorar o serviço.
          </p>
        </div>

        <div className="space-y-2">
          <h3 className="font-bold text-gray-900 flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-blue-600 rounded-full"></span>
            Versão Completa
          </h3>
          <p>
            Você pode acessar a versão completa da nossa Política de Privacidade a qualquer momento através do link abaixo ou nas configurações do app.
          </p>
        </div>

        <div className="pt-4 flex justify-center">
          <a 
            href="/#/privacy" 
            target="_blank" 
            rel="noopener noreferrer"
            className="text-blue-600 font-bold hover:underline flex items-center gap-1.5"
          >
            Ver versão completa da Política de Privacidade
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        </div>

        <div className="pt-4 border-t border-gray-100 italic text-xs text-gray-400">
          Ao clicar em "Aceitar", você confirma que leu e concorda com a <strong>versão completa</strong> da nossa Política de Privacidade e Termos de Uso.
        </div>

      </div>
    </Modal>
  );
};

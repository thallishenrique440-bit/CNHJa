import React from 'react';
import { Modal } from './Modal';
import { Button } from './Button';
import { Link } from 'react-router-dom';

interface PrivacyModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAccept: () => void;
  role?: 'student' | 'instructor';
}

export const PrivacyModal: React.FC<PrivacyModalProps> = ({ isOpen, onClose, onAccept, role = 'student' }) => {
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
        
        <div className="flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-extrabold bg-blue-50 text-blue-700 border border-blue-100 uppercase tracking-wider w-fit">
          Perfil: {role === 'instructor' ? 'Instrutor' : 'Aluno'}
        </div>

        <div className="space-y-2">
          <h3 className="font-bold text-gray-900 flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-blue-600 rounded-full"></span>
            O que coletamos
          </h3>
          <p>
            Coletamos dados básicos como seu nome, e-mail, WhatsApp e cidade para criar seu perfil e permitir {role === 'instructor' ? 'que você atenda seus alunos' : 'o agendamento das aulas'} com segurança.
          </p>
        </div>

        <div className="space-y-2">
          <h3 className="font-bold text-gray-900 flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-blue-600 rounded-full"></span>
            Como usamos seus dados
          </h3>
          <p>
            Suas informações são usadas para gerenciar seus agendamentos, processar pagamentos e garantir {role === 'instructor' ? 'o bom andamento de suas atividades na plataforma' : 'que você tenha a melhor experiência de aprendizado possível'}.
          </p>
        </div>

        {role === 'student' ? (
          <div className="space-y-2">
            <h3 className="font-bold text-gray-900 flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-blue-600 rounded-full"></span>
              Compartilhamento com Instrutores
            </h3>
            <p>
              Para facilitar a aula, compartilhamos seu nome e WhatsApp com o instrutor escolhido <strong>somente após a confirmação do agendamento</strong>. O instrutor passa a ser responsável pelo uso adequado dessas informações.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <h3 className="font-bold text-gray-900 flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-blue-600 rounded-full"></span>
              Tratamento de Dados de Alunos
            </h3>
            <p>
              O Instrutor concorda em receber o nome e o WhatsApp do Aluno unicamente para coordenação das aulas práticas e compromete-se a tratar tais dados pessoais em total conformidade com a LGPD, sendo vedado o uso para fins publicitários ou compartilhamento com terceiros não autorizados.
            </p>
          </div>
        )}

        <div className="space-y-2">
          <h3 className="font-bold text-gray-900 flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-blue-600 rounded-full"></span>
            Pagamentos Seguros (Asaas)
          </h3>
          <p>
            Seus pagamentos e repasses são processados com total segurança através do <strong>Asaas</strong>, nosso parceiro financeiro e instituição autorizada pelo Banco Central. <strong>Nós não temos acesso e não armazenamos os dados de pagamento</strong> em nossos sistemas.
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
            Não vendemos seus dados para terceiros. O uso das informações é estritamente operacional, focado na intermediação de serviços e na melhoria da plataforma.
          </p>
        </div>

        <div className="pt-4 flex justify-center">
          <Link 
            to="/privacy?from=register" 
            state={{ role }}
            className="text-blue-600 font-bold hover:underline flex items-center gap-1.5"
          >
            Ver versão completa da Política de Privacidade
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </Link>
        </div>

        <div className="pt-4 border-t border-gray-100 italic text-xs text-gray-400">
          Ao clicar em "Aceitar", você confirma que leu e concorda com a <strong>versão completa</strong> da nossa Política de Privacidade e Termos de Uso.
        </div>

      </div>
    </Modal>
  );
};

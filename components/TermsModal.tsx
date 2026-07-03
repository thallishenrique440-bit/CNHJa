import React from 'react';
import { Modal } from './Modal';
import { Button } from './Button';
import { Link } from 'react-router-dom';
import { APP_CONFIG } from '../constants';

interface TermsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAccept: () => void;
  role?: 'student' | 'instructor';
}

export const TermsModal: React.FC<TermsModalProps> = ({ isOpen, onClose, onAccept, role = 'student' }) => {
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
        
        <div className="flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-extrabold bg-blue-50 text-blue-700 border border-blue-100 uppercase tracking-wider w-fit">
          Perfil: {role === 'instructor' ? 'Instrutor' : 'Aluno'}
        </div>

        <div className="space-y-2">
          <h3 className="font-bold text-gray-900 flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-blue-600 rounded-full"></span>
            O que somos
          </h3>
          <p>
            Somos um marketplace que conecta {role === 'instructor' ? 'instrutores de direção independentes a alunos interessados' : 'você a instrutores independentes'}. Facilitamos o agendamento e o pagamento.
          </p>
        </div>

        {role === 'student' ? (
          <>
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
                Compromisso e Faltas
              </h3>
              <p>
                Fique atento ao horário. Cancelamentos com menos de 24h ou faltas não dão direito a reembolso.
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="space-y-2">
              <h3 className="font-bold text-gray-900 flex items-center gap-2">
                <span className="w-1.5 h-1.5 bg-blue-600 rounded-full"></span>
                Credenciamento e Obrigações
              </h3>
              <p>
                O Instrutor deve possuir credencial ativa do DETRAN, CNH com EAR, e veículo em perfeitas condições de uso, licenciamento e seguro.
              </p>
            </div>

            <div className="space-y-2">
              <h3 className="font-bold text-gray-900 flex items-center gap-2">
                <span className="w-1.5 h-1.5 bg-blue-600 rounded-full"></span>
                Repasses e Subconta Asaas
              </h3>
              <p>
                Seus ganhos são processados e repassados de forma segura através da sua subconta Asaas. Retemos uma comissão sobre cada aula intermediada.
              </p>
            </div>

            <div className="space-y-2">
              <h3 className="font-bold text-gray-900 flex items-center gap-2">
                <span className="w-1.5 h-1.5 bg-blue-600 rounded-full"></span>
                Atuação Independente
              </h3>
              <p>
                O Instrutor atua de forma autônoma e assume total responsabilidade civil, criminal e de trânsito pela condução e segurança das aulas práticas.
              </p>
            </div>
          </>
        )}

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
            Usamos o <strong>Asaas</strong>, nosso parceiro financeiro homologado pelo Banco Central, para processar todos os pagamentos e repasses com total segurança.
          </p>
        </div>

        <div className="space-y-2">
          <h3 className="font-bold text-gray-900 flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-blue-600 rounded-full"></span>
            Segurança
          </h3>
          <p>
            {role === 'instructor' 
              ? 'O aluno poderá compartilhar sua localização em tempo real pelo app durante a aula para segurança de ambos.'
              : 'Você pode compartilhar sua localização em tempo real pelo app durante a aula para sua segurança pessoal.'}
          </p>
        </div>

        <div className="space-y-2">
          <h3 className="font-bold text-gray-900 flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-blue-600 rounded-full"></span>
            Respeito Mútuo
          </h3>
          <p>
            Não toleramos desrespeito de qualquer parte. Mantenha sempre a conduta ética e o profissionalismo.
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
          <Link 
            to="/terms?from=register" 
            state={{ role }}
            className="text-blue-600 font-bold hover:underline flex items-center gap-1.5"
          >
            Ver versão completa dos Termos de Uso
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </Link>
        </div>

        <div className="pt-4 border-t border-gray-100 italic text-xs text-gray-400">
          Ao clicar em "Aceitar", você confirma que leu e concorda com a <strong>versão completa</strong> dos nossos Termos de Uso e Política de Privacidade.
        </div>

      </div>
    </Modal>
  );
};

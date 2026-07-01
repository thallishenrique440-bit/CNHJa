import React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '../components/Button';
import { APP_CONFIG } from '../constants';

export const Terms: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const fromRegister = searchParams.get('from') === 'register';
  const lastUpdate = "04 de abril de 2026";

  const handleAgree = () => {
    if (fromRegister) {
      localStorage.setItem('ab_terms_agreed', 'true');
    }
    navigate(-1);
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50/50 via-white to-white flex flex-col px-6 py-10 sm:justify-center items-center">
      
      <div className="w-full max-w-2xl flex justify-start mb-6">
        <button 
          onClick={() => navigate(-1)} 
          className="p-2 -ml-2 text-gray-400 hover:text-blue-600 rounded-full hover:bg-blue-50 transition-all duration-200 group"
        >
          <svg className="w-6 h-6 transform group-hover:-translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      </div>

      <div className="w-full max-w-2xl bg-white rounded-3xl shadow-2xl shadow-blue-100/50 border border-gray-100 p-8 sm:p-12 space-y-10">
        
        <div className="text-center space-y-4">
          <h1 className="text-3xl font-extrabold text-gray-900 tracking-tight">
            Termos e Condições de Uso
          </h1>
          <p className="text-gray-400 text-sm font-medium uppercase tracking-widest">
            Última atualização: {lastUpdate}
          </p>
        </div>

        <div className="prose prose-blue max-w-none text-gray-600 space-y-8 leading-relaxed">
          
          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">1. Sobre a plataforma</h2>
            <p>
              A CNHJá é uma plataforma tecnológica que atua como um marketplace, conectando alunos interessados em aprender a dirigir ou aperfeiçoar sua condução a instrutores de direção independentes. A plataforma facilita o agendamento de aulas e o processamento de pagamentos, não sendo proprietária de veículos nem empregadora direta dos instrutores.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">2. Cadastro e conta do usuário</h2>
            <p>
              Para utilizar os serviços, o Aluno deve realizar um cadastro fornecendo informações verídicas e completas. A conta é pessoal e intransferível. O Aluno é responsável pela segurança de suas credenciais de acesso.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">3. Uso da plataforma</h2>
            <p>
              O Aluno compromete-se a utilizar a plataforma de forma ética e legal, sendo proibido o uso de identidades falsas ou a tentativa de burlar sistemas de segurança.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">4. Agendamento de aulas</h2>
            <p>
              As aulas são agendadas diretamente através da agenda do instrutor. O agendamento é confirmado apenas após a validação do pagamento pela nossa instituição de pagamento parceira. O Aluno deve comparecer ao ponto de encontro no horário combinado.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">5. Pagamentos e Transações</h2>
            <p>
              Todos os pagamentos são processados com total segurança através de nossa instituição de pagamento parceira (atualmente o <strong>Asaas</strong>). A CNHJá não armazena dados sensíveis de cartões de crédito. O Aluno concorda com o valor total da aula e eventuais taxas aplicáveis no momento da reserva.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">6. Cancelamentos e faltas</h2>
            <p>
              Cancelamentos com mais de 24 horas de antecedência permitem estorno integral. Cancelamentos com menos de 24 horas ou não comparecimento (falta) podem resultar na retenção do valor total para compensar o instrutor.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">7. Responsabilidade e Isenção de Garantias</h2>
            <p>
              Os instrutores são profissionais independentes e totalmente responsáveis pela condução das aulas e manutenção de seus veículos. <strong>A CNHJá não garante, sob nenhuma hipótese, a aprovação do Aluno em exames práticos ou teóricos para obtenção da CNH</strong>, sendo a plataforma apenas uma facilitadora de ensino.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">8. Limitação de Responsabilidade</h2>
            <p>
              <strong>A plataforma não se responsabiliza por quaisquer danos (materiais ou morais), acidentes, furtos ou problemas de conduta ocorridos durante as aulas ou na relação direta entre Aluno e Instrutor.</strong> O Aluno reconhece que a atividade de direção envolve riscos inerentes e declara estar ciente desses riscos ao participar das aulas.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">9. Avaliações e conduta</h2>
            <p>
              Avaliações devem ser honestas e respeitosas. Comportamentos inadequados ou assédio resultarão na exclusão imediata da conta e possíveis medidas legais.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">10. Privacidade e dados (LGPD)</h2>
            <p>
              O tratamento de dados segue a LGPD. Coletamos apenas o necessário para a prestação do serviço e compartilhamos o WhatsApp com o instrutor apenas para coordenação das aulas.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">11. Suspensão ou exclusão de conta</h2>
            <p>
              A plataforma reserva-se o direito de suspender contas que violem estes termos ou pratiquem fraudes, sem aviso prévio.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">12. Alterações nos termos</h2>
            <p>
              Estes termos podem ser atualizados periodicamente. O Aluno será notificado sobre mudanças significativas e o uso continuado da plataforma após as alterações constitui aceitação dos novos termos.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">13. Legislação e Foro</h2>
            <p>
              <strong>Este termo é regido integralmente pelas leis brasileiras.</strong> Fica eleito o foro da comarca de São Paulo/SP para dirimir quaisquer controvérsias oriundas deste documento.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">14. Contato</h2>
            <p>
              Dúvidas podem ser enviadas para {APP_CONFIG.SUPPORT_EMAIL}.
            </p>
          </section>

        </div>

        <div className="pt-8 border-t border-gray-100 flex justify-center">
          <Button onClick={handleAgree} className="px-12 py-3.5">
            Entendi e concordo
          </Button>
        </div>

      </div>

      <div className="mt-8 text-center">
        <p className="text-[10px] text-gray-300 font-medium tracking-widest uppercase">
          © {APP_CONFIG.YEAR} {APP_CONFIG.NAME}
        </p>
      </div>

    </div>
  );
};

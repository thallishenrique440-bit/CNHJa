import React from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { Button } from '../components/Button';
import { APP_CONFIG } from '../constants';
import { useAuth } from '../contexts/AuthContext';

export const Terms: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { userRole } = useAuth();

  // Discover the role automatically:
  // 1. Authenticated user's role from AuthContext
  // 2. Context from state passed by the opening page/modal
  // 3. Fallback to student
  const role = userRole || location.state?.role || 'student';

  const fromRegister = searchParams.get('from') === 'register';
  const lastUpdate = "04 de julho de 2026";

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
          
          <div className="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold bg-blue-50 text-blue-700 border border-blue-100 uppercase tracking-wider">
            Perfil: {role === 'instructor' ? 'Instrutor' : 'Aluno'}
          </div>

          <p className="text-gray-400 text-sm font-medium uppercase tracking-widest">
            Última atualização: {lastUpdate}
          </p>
        </div>

        <div className="prose prose-blue max-w-none text-gray-600 space-y-8 leading-relaxed">
          
          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">1. Sobre a plataforma</h2>
            <p>
              A CNHJá é uma plataforma tecnológica que atua como um marketplace de intermediação de serviços, conectando alunos interessados em aprender a dirigir ou aperfeiçoar sua condução a instrutores de direção independentes e credenciados. A plataforma facilita o agendamento de aulas práticas e gerencia de maneira segura o processamento e a liquidação dos pagamentos. A CNHJá não é proprietária de veículos, não presta diretamente serviços de formação de condutores e não possui qualquer vínculo empregatício ou de subordinação com os instrutores parceiros cadastrados.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">2. Cadastro e conta do usuário</h2>
            {role === 'student' ? (
              <p>
                Para usufruir dos serviços oferecidos na plataforma, o Aluno deve realizar um cadastro pessoal e intransferível fornecendo informações verídicas, completas e atualizadas. O Aluno assume total responsabilidade pela confidencialidade e segurança de suas credenciais de acesso, bem como por todas as atividades executadas por meio de sua conta.
              </p>
            ) : (
              <p>
                Para atuar como parceiro na plataforma, o Instrutor deve realizar um cadastro detalhado e passar por um processo rigoroso de credenciamento. É obrigatório apresentar credencial de instrutor válida e ativa emitida pelo DETRAN do respectivo estado de atuação, Carteira Nacional de Habilitação (CNH) com a anotação de Exercício de Atividade Remunerada (EAR), além de documentação regular do veículo de treinamento. O Instrutor obriga-se a manter todas as suas informações cadastrais e documentações legais rigorosamente atualizadas.
              </p>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">3. Uso da plataforma</h2>
            <p>
              Os usuários comprometem-se a utilizar as funcionalidades da plataforma de forma ética, lícita e transparente. É estritamente proibido o uso de identidades falsas, a simulação de transações, tentativas de violação ou engenharia reversa de nossos sistemas de segurança, bem como qualquer comportamento que possa prejudicar o bom funcionamento do ecossistema CNHJá.
            </p>
          </section>

          {role === 'student' ? (
            <>
              <section className="space-y-3">
                <h2 className="text-xl font-bold text-gray-900">4. Compra e Agendamento de Aulas</h2>
                <p>
                  As aulas práticas são adquiridas pelo Aluno diretamente através da plataforma CNHJá, selecionando os instrutores com base em suas avaliações, horários disponíveis e regiões de atendimento. Um agendamento é considerado confirmado apenas após a validação e autorização do respectivo pagamento por nossa instituição de pagamento parceira. O Aluno obriga-se a comparecer pontualmente ao ponto de encontro previamente acordado para o início da instrução.
                </p>
              </section>

              <section className="space-y-3">
                <h2 className="text-xl font-bold text-gray-900">5. Pagamentos e Transações</h2>
                <p>
                  Todos os pagamentos na plataforma são processados com total segurança através da nossa instituição financeira parceira homologada (<strong>Asaas</strong>). O Aluno autoriza a CNHJá a processar a cobrança do valor total correspondente às aulas reservadas no momento do agendamento. A plataforma não armazena dados de cartões de crédito em servidores internos.
                </p>
              </section>

              <section className="space-y-3">
                <h2 className="text-xl font-bold text-gray-900">6. Políticas de Cancelamento, Reembolsos e Faltas (No-Show)</h2>
                <p>
                  Cancelamentos de aulas agendadas realizados pelo Aluno com mais de 24 horas de antecedência em relação ao horário de início da aula dão direito ao estorno ou reembolso integral do valor pago. Cancelamentos realizados com menos de 24 horas de antecedência, ou o não comparecimento do Aluno no horário e local acordados (no-show), implicarão na retenção do valor total da aula como compensação financeira ao Instrutor que reservou seu tempo de serviço e disponibilizou o veículo.
                </p>
              </section>

              <section className="space-y-3">
                <h2 className="text-xl font-bold text-gray-900">7. Responsabilidade sobre Aprovação e Isenção de Garantias</h2>
                <p>
                  O Aluno reconhece e declara estar ciente de que as aulas ministradas pelos instrutores cadastrados são ferramentas de auxílio ao aprendizado prático de direção de veículos. <strong>A CNHJá não oferece, sob qualquer pretexto, qualquer garantia de aprovação do Aluno em exames práticos ou teóricos junto aos órgãos de trânsito (DETRAN) para fins de obtenção da Carteira Nacional de Habilitação (CNH)</strong>, sendo esta uma atribuição exclusiva do desempenho pessoal do Aluno e avaliação direta do órgão examinador competente.
                </p>
              </section>
            </>
          ) : (
            <>
              <section className="space-y-3">
                <h2 className="text-xl font-bold text-gray-900">4. Obrigações Profissionais e Regulamentares do Instrutor</h2>
                <p>
                  O Instrutor compromete-se a prestar os serviços de ensino de direção de forma profissional, cortês, ética, e com pontualidade exemplar. É dever imperativo do Instrutor respeitar rigorosamente as normas de trânsito aplicáveis e zelar pela integridade física e emocional do Aluno durante toda a aula prática.
                </p>
              </section>

              <section className="space-y-3">
                <h2 className="text-xl font-bold text-gray-900">5. Condições do Veículo de Treinamento</h2>
                <p>
                  O Instrutor é o único e exclusivo responsável por disponibilizar um veículo em perfeitas condições mecânicas, de segurança, higiene e conservação para a realização das aulas práticas intermediadas pela plataforma. O veículo deve cumprir integralmente todas as exigências estabelecidas pelos órgãos de trânsito competentes, possuir licenciamento anual regularizado e cobertura de seguro vigente para proteção de condutor e passageiros.
                </p>
              </section>

              <section className="space-y-3">
                <h2 className="text-xl font-bold text-gray-900">6. Repasses Financeiros, Subconta Asaas e Comissão da Plataforma</h2>
                <p>
                  Todos os recebimentos gerados pelas aulas são processados via instituição de pagamento parceira (<strong>Asaas</strong>). O Instrutor, para habilitar o recebimento de seus repasses, expressamente concorda e autoriza a abertura de uma subconta de pagamento Asaas vinculada ao seu perfil na CNHJá. A comissão de intermediação de serviços devida à plataforma CNHJá será automaticamente retida sobre o valor bruto de cada aula realizada. Os repasses dos valores líquidos correspondentes às aulas prestadas serão liquidados diretamente na subconta ou conta bancária indicada pelo Instrutor, de acordo com os prazos operacionais definidos.
                </p>
              </section>

              <section className="space-y-3">
                <h2 className="text-xl font-bold text-gray-900">7. Responsabilidades e Ausência de Vínculo Empregatício</h2>
                <p>
                  O Instrutor declara expressamente que é um profissional autônomo e independente, inexistindo qualquer relação de emprego, subordinação jurídica ou dependência econômica entre o Instrutor e a CNHJá. <strong>O Instrutor assume de forma integral e exclusiva toda a responsabilidade civil, administrativa e criminal decorrente da atividade de instrução</strong>, incluindo, mas não se limitando a, acidentes de trânsito, infrações de trânsito e respectivas multas aplicadas pelos órgãos competentes, bem como danos de qualquer natureza causados ao Aluno ou a terceiros durante a realização das aulas.
                </p>
              </section>
            </>
          )}

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">8. Limitação de Responsabilidade da Plataforma</h2>
            <p>
              A CNHJá atua unicamente como intermediadora tecnológica entre as partes. <strong>A plataforma não se responsabiliza por quaisquer danos materiais, morais, lucros cessantes, acidentes de trânsito, furtos, agressões físicas ou verbais ou desvios de conduta ocorridos na relação direta e presencial estabelecida entre o Aluno e o Instrutor.</strong> Ambas as partes reconhecem que a atividade prática de direção veicular envolve riscos intrínsecos e aceitam tais condições de forma livre e consciente.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">9. Avaliações e Conduta Ética</h2>
            <p>
              A plataforma disponibiliza um canal de avaliação mútua para promover a segurança e a qualidade do serviço. As avaliações de conduta e desempenho devem ser prestadas de forma verídica, construtiva e respeitosa. Comportamentos abusivos, assédio, linguagem inadequada ou discriminação ensejarão a suspensão ou o banimento imediato e irreversível da conta do usuário infrator, sem prejuízo da adoção das medidas judiciais cabíveis.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">10. Proteção de Dados e Privacidade (LGPD)</h2>
            <p>
              O tratamento e o compartilhamento de dados pessoais realizados pela plataforma CNHJá ocorrem de acordo com a Lei Geral de Proteção de Dados (LGPD). Os dados cadastrais coletados destinam-se exclusivamente à operacionalização do serviço contratado. Para a perfeita coordenação operacional das aulas práticas agendadas, a plataforma compartilhará com as partes os respectivos dados de identificação e contato (WhatsApp) estritamente necessários para viabilizar o encontro, responsabilizando-se cada parte pelo uso ético e confidencial dessas informações.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">11. Suspensão ou Exclusão de Conta</h2>
            <p>
              A CNHJá reserva-se o direito de, a seu exclusivo critério e sem necessidade de notificação prévia, suspender temporariamente ou excluir permanentemente a conta de qualquer usuário que descumpra as cláusulas deste termo, viole leis ou regulamentos aplicáveis ou pratique atos fraudulentos na utilização da plataforma.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">12. Alterações e Atualizações dos Termos</h2>
            <p>
              Estes Termos de Uso poderão ser modificados ou atualizados periodicamente para refletir mudanças na legislação vigente ou melhorias operacionais da plataforma. Os usuários serão devidamente informados sobre alterações relevantes por meio de notificações internas no aplicativo ou e-mail. A continuidade do uso do serviço após a publicação das atualizações constituirá plena aceitação dos novos termos de uso.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">13. Legislação Aplicável e Foro de Eleição</h2>
            <p>
              Este documento e a relação jurídica dele decorrente são regidos integralmente pelas leis vigentes na República Federativa do Brasil. Para dirimir quaisquer litígios, dúvidas ou controvérsias oriundas deste termo, as partes elegem expressamente o foro central da comarca de São Paulo/SP, renunciando a qualquer outro por mais privilegiado que seja.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">14. Canais de Atendimento e Suporte</h2>
            <p>
              Para esclarecer dúvidas sobre os Termos de Uso ou contatar o suporte da plataforma, o usuário poderá encaminhar uma mensagem de e-mail para: <strong>{APP_CONFIG.SUPPORT_EMAIL}</strong>.
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

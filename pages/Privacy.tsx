import React from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { Button } from '../components/Button';
import { APP_CONFIG } from '../constants';
import { useAuth } from '../contexts/AuthContext';

export const Privacy: React.FC = () => {
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
      localStorage.setItem('ab_privacy_agreed', 'true');
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
            Política de Privacidade
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
            <h2 className="text-xl font-bold text-gray-900">1. Introdução</h2>
            <p>
              Esta Política de Privacidade descreve de forma clara e transparente como a plataforma CNHJá coleta, armazena, processa, utiliza e compartilha as suas informações pessoais. O tratamento de dados pessoais realizado por nossos sistemas eletrônicos ocorre com absoluto respeito à privacidade, pautando-se em bases legais legítimas, em especial para a execução das relações de intermediação de serviços e no estrito cumprimento dos ditames da Lei Geral de Proteção de Dados (LGPD - Lei nº 13.709/2018).
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">2. Coleta de Dados Pessoais</h2>
            <p>
              Coletamos informações cadastrais e de uso fornecidas diretamente por você ao registrar sua conta e interagir na plataforma:
            </p>
            {role === 'student' ? (
              <ul className="list-disc pl-5 space-y-2">
                <li><strong>Dados Cadastrais:</strong> Nome completo, e-mail, número de telefone celular (WhatsApp) e cidade de residência.</li>
                <li><strong>Dados do Perfil de Aprendizado:</strong> Nível atual de experiência na condução de veículos e tipo de processo da CNH.</li>
                <li><strong>Dados de Transações e Uso:</strong> Histórico de aulas práticas agendadas, avaliações atribuídas aos instrutores e interações de suporte.</li>
                <li><strong>Dados de Navegação:</strong> Endereço IP, cookies operacionais necessários e tipo de dispositivo móvel ou navegador web.</li>
              </ul>
            ) : (
              <ul className="list-disc pl-5 space-y-2">
                <li><strong>Dados Cadastrais e Profissionais:</strong> Nome completo, e-mail, número de WhatsApp, cidade e região de atuação profissional.</li>
                <li><strong>Documentos de Habilitação e Credenciamento:</strong> Foto ou documento digitalizado da CNH com anotação EAR, credencial oficial de instrutor emitida pelo DETRAN e comprovante de regularidade cadastral.</li>
                <li><strong>Dados do Veículo de Treinamento:</strong> Modelo do veículo, placa, documento de licenciamento anual e comprovante de seguro ativo.</li>
                <li><strong>Dados Financeiros e de Repasse:</strong> Informações de conta bancária para recebimento de transferências e dados necessários para a abertura e conformidade de subconta de pagamento.</li>
              </ul>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">3. Finalidade e Uso dos Dados</h2>
            <p>
              Seus dados pessoais são utilizados unicamente para finalidades operacionais essenciais e para a contínua otimização da plataforma:
            </p>
            {role === 'student' ? (
              <ul className="list-disc pl-5 space-y-2">
                <li>Gerenciamento regular de sua conta e segurança de autenticação;</li>
                <li>Facilitação operacional de agendamentos e verificação de horários de aulas práticas;</li>
                <li>Intermediação e processamento seguro do pagamento das aulas por meio do parceiro de pagamento;</li>
                <li>Envio de comunicações automáticas sobre agendamentos, atualizações e suporte ao usuário;</li>
                <li>Personalização de buscas e exibição dos instrutores mais adequados à sua região.</li>
              </ul>
            ) : (
              <ul className="list-disc pl-5 space-y-2">
                <li>Validação e auditoria de suas credenciais oficiais do DETRAN para habilitação do perfil;</li>
                <li>Configuração da agenda de aulas e disponibilização de horários de atendimento aos alunos;</li>
                <li>Liquidação financeira e transferência automatizada dos repasses líquidos decorrentes das aulas realizadas;</li>
                <li>Exibição pública de seu perfil de atendimento, qualificações e avaliações aos alunos interessados;</li>
                <li>Apoio administrativo e comunicação de atualizações técnicas na prestação do serviço de marketplace.</li>
              </ul>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">4. Compartilhamento de Dados entre as Partes e Proteção na LGPD</h2>
            {role === 'student' ? (
              <p>
                Para viabilizar a realização da aula prática, compartilhamos informações operacionais específicas de identificação. <strong>Após a devida confirmação de um agendamento de aula, seu nome e seu número de WhatsApp são compartilhados com o Instrutor escolhido</strong> para possibilitar o contato direto visando à coordenação de local de encontro e horário de início da aula. O Aluno reconhece e concorda que, a partir do momento em que tais dados são disponibilizados para fins operacionais, o Instrutor passa a atuar como controlador de dados independente, devendo manter total sigilo e zelo de tais informações.
              </p>
            ) : (
              <p>
                <strong>O Instrutor concorda em receber o nome e o WhatsApp do Aluno unicamente para fins de coordenação de local e horário das aulas práticas agendadas.</strong> O Instrutor compromete-se a tratar todos os dados pessoais recebidos em estrita e total conformidade com os princípios estabelecidos pela Lei Geral de Proteção de Dados (LGPD), sendo terminantemente vedada a utilização de tais dados para envio de comunicações publicitárias, venda de produtos externos, formação de bancos de dados paralelos, ou compartilhamento com terceiros não autorizados, sob pena de exclusão irrevogável da plataforma e responsabilização legal por eventuais vazamentos ou usos indevidos.
              </p>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">5. Processamento Seguro de Pagamentos (Asaas)</h2>
            <p>
              Todas as transações e movimentações financeiras executadas na plataforma CNHJá são operacionalizadas por meio do <strong>Asaas</strong>, instituição de pagamento parceira autorizada pelo Banco Central do Brasil.
            </p>
            <ul className="list-disc pl-5 space-y-2">
              <li><strong>Ambiente Criptografado:</strong> Os dados de cartões, transações Pix ou boletos são inseridos diretamente no ecossistema criptografado e seguro mantido pelo Asaas, em total conformidade com os padrões de segurança internacional da indústria de meios de pagamento (PCI-DSS).</li>
              <li><strong>Não Armazenamento de Dados Sensíveis:</strong> Nossa plataforma <strong>NÃO armazena e NÃO possui acesso aos dados sensíveis de pagamento</strong> (como números de cartão, códigos de verificação ou chaves de autenticação), garantindo total privacidade e blindagem de suas informações financeiras em nossos servidores.</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">6. Segurança da Informação</h2>
            <p>
              Implementamos e mantemos rígidas medidas técnicas, organizacionais e administrativas de segurança projetadas para proteger seus dados pessoais contra incidentes de segurança, acessos não autorizados, perdas acidentais, modificações não permitidas ou difusões ilícitas. Nossos servidores utilizam protocolos de criptografia TLS para transmissão em trânsito e criptografia robusta de armazenamento em repouso.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">7. Seus Direitos Legais como Titular de Dados (LGPD)</h2>
            <p>
              Em conformidade com as regras estabelecidas pelo artigo 18 da Lei Geral de Proteção de Dados (LGPD), você poderá exercer, de forma simplificada e gratuita, os seus direitos legais a qualquer momento:
            </p>
            <ul className="list-disc pl-5 space-y-2">
              <li>Confirmação de que estamos realizando o tratamento de seus dados pessoais;</li>
              <li>Acesso transparente aos dados pessoais armazenados em nosso sistema;</li>
              <li>Correção imediata de informações que estejam incompletas, inexatas ou desatualizadas;</li>
              <li>Anonimização, bloqueio ou eliminação de dados considerados desnecessários ou tratados em desconformidade com a lei;</li>
              <li>Eliminação definitiva de seus dados cadastrais mediante solicitação formal de exclusão (ressalvada a guarda de dados necessária para obrigações legais, fiscais ou cumprimento regulatório);</li>
              <li>Revogação do consentimento concedido anteriormente para tratamentos de dados específicos.</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">8. Cookies e Tecnologias de Navegação</h2>
            <p>
              Utilizamos cookies estritamente operacionais necessários para manter o login ativo, lembrar suas preferências básicas de pesquisa e otimizar o tempo de carregamento do sistema. Você poderá desabilitar o recebimento de cookies através das preferências internas de segurança do seu próprio navegador, estando ciente de que tal desativação poderá comprometer ou limitar algumas funcionalidades essenciais da plataforma CNHJá.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">9. Prazos de Retenção de Dados Pessoais</h2>
            <p>
              Conservamos suas informações pessoais em nossos servidores apenas pelo tempo necessário para cumprir integralmente com as finalidades descritas nesta Política de Privacidade, ou conforme exigido pela legislação aplicável para cumprimento de obrigações regulatórias, fiscais, contábeis, comprovação de agendamentos e transações, bem como para a segurança de defesa jurídica em processos judiciais ou administrativos.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">10. Modificações na Política de Privacidade</h2>
            <p>
              Esta Política de Privacidade poderá ser alterada e atualizada periodicamente para refletir avanços operacionais, novos recursos tecnológicos ou adequações normativas. Sempre que houver alguma atualização significativa, você será devidamente notificado através de canais de comunicação interna do sistema ou e-mail. O uso regular e continuado da plataforma CNHJá após a divulgação das atualizações constituirá aceitação voluntária da nova versão da política de privacidade.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">11. Atendimento de Privacidade e Encarregado de Dados (DPO)</h2>
            <p>
              Para esclarecer quaisquer dúvidas pendentes relacionadas à presente Política de Privacidade, exercer os seus direitos de titular de dados sob a LGPD, ou requerer a exclusão ou retificação de suas informações pessoais, você poderá encaminhar uma solicitação formal diretamente ao nosso canal de privacidade por meio do e-mail oficial: <strong>{APP_CONFIG.PRIVACY_EMAIL}</strong>.
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

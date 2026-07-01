import React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '../components/Button';
import { APP_CONFIG } from '../constants';

export const Privacy: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const fromRegister = searchParams.get('from') === 'register';
  const lastUpdate = "04 de abril de 2026";

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
          <p className="text-gray-400 text-sm font-medium uppercase tracking-widest">
            Última atualização: {lastUpdate}
          </p>
        </div>

        <div className="prose prose-blue max-w-none text-gray-600 space-y-8 leading-relaxed">
          
          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">1. Introdução</h2>
            <p>
              Esta Política de Privacidade descreve como coletamos, usamos, processamos e compartilhamos suas informações pessoais em nossa plataforma. O tratamento de dados ocorre com base no seu consentimento e na execução do contrato de prestação de serviços, em conformidade com a Lei Geral de Proteção de Dados (LGPD - Lei nº 13.709/2018).
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">2. Coleta de Dados</h2>
            <p>
              Coletamos informações que você nos fornece diretamente ao criar uma conta e utilizar a plataforma:
            </p>
            <ul className="list-disc pl-5 space-y-2">
              <li><strong>Dados Cadastrais:</strong> Nome completo, e-mail, número de telefone (WhatsApp), cidade e região.</li>
              <li><strong>Dados de Perfil:</strong> Nível de experiência na direção e tipo de processo de CNH.</li>
              <li><strong>Dados de Uso:</strong> Histórico de agendamentos, aulas realizadas, avaliações enviadas e interações com o suporte.</li>
              <li><strong>Dados Automáticos:</strong> Endereço IP, tipo de navegador e cookies de navegação.</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">3. Uso dos Dados</h2>
            <p>
              Seus dados são utilizados para finalidades operacionais e de melhoria do serviço:
            </p>
            <ul className="list-disc pl-5 space-y-2">
              <li>Gerenciamento de conta e identificação do usuário;</li>
              <li>Facilitação e confirmação de agendamentos de aulas;</li>
              <li>Processamento de pagamentos e emissão de comprovantes;</li>
              <li>Comunicação sobre agendamentos, atualizações e suporte técnico;</li>
              <li>Personalização da experiência e análise de desempenho da plataforma.</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">4. Compartilhamento de Dados</h2>
            <p>
              Para o funcionamento do marketplace, compartilhamos informações específicas:
            </p>
            <ul className="list-disc pl-5 space-y-2">
              <li><strong>Com Instrutores:</strong> Após a confirmação de um agendamento, seu nome e número de WhatsApp são compartilhados com o instrutor para permitir a comunicação direta sobre a aula. <strong>O Aluno reconhece que, após o compartilhamento, o instrutor passa a ser responsável pelo uso adequado dessas informações.</strong></li>
              <li><strong>Localização:</strong> Caso utilize a função de compartilhamento de rota em tempo real, sua localização será visível apenas para o instrutor durante o período da aula.</li>
              <li><strong>Provedores de Serviço:</strong> Compartilhamos dados com parceiros tecnológicos (como hospedagem e processamento de pagamentos) estritamente para a execução do serviço.</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">5. Pagamentos e Transações Financeiras</h2>
            <p>
              Todos os pagamentos na plataforma são processados por uma <strong>instituição de pagamento parceira</strong> (atualmente o <strong>Asaas</strong>).
            </p>
            <ul className="list-disc pl-5 space-y-2">
              <li><strong>Segurança:</strong> Os dados de pagamento, incluindo cartão de crédito ou débito, pix ou boletos, são inseridos diretamente no ambiente seguro e criptografado da instituição parceira.</li>
              <li><strong>Não Armazenamento:</strong> Nossa plataforma <strong>NÃO armazena</strong> dados sensíveis de pagamento (como número do cartão ou código de segurança) em nossos servidores.</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">6. Armazenamento e Segurança</h2>
            <p>
              Adotamos medidas técnicas e administrativas para proteger seus dados contra acessos não autorizados, perda, alteração ou destruição. Seus dados são armazenados em servidores de alta segurança com criptografia de dados em repouso e em trânsito.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">7. Direitos do Usuário (LGPD)</h2>
            <p>
              Como titular dos dados, você possui os seguintes direitos:
            </p>
            <ul className="list-disc pl-5 space-y-2">
              <li>Confirmar a existência de tratamento de seus dados;</li>
              <li>Acessar e solicitar uma cópia de seus dados pessoais;</li>
              <li>Corrigir dados incompletos, inexatos ou desatualizados;</li>
              <li>Solicitar a exclusão de seus dados (exceto quando a retenção for necessária para cumprimento de obrigação legal);</li>
              <li>Revogar o consentimento a qualquer momento.</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">8. Cookies e Tecnologias de Rastreamento</h2>
            <p>
              Utilizamos cookies para melhorar a navegação, lembrar suas preferências e analisar o tráfego. Você pode configurar seu navegador para recusar cookies, mas isso pode afetar algumas funcionalidades da plataforma.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">9. Retenção de Dados</h2>
            <p>
              Mantemos seus dados pessoais apenas pelo tempo necessário para cumprir as finalidades descritas nesta política, ou para o cumprimento de obrigações legais e regulatórias, prevenção a fraudes e defesa em processos judiciais ou administrativos.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">10. Alterações na Política</h2>
            <p>
              Esta política pode ser atualizada periodicamente. Notificaremos você sobre mudanças significativas. O uso contínuo da plataforma após as alterações constitui aceitação da nova política.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-bold text-gray-900">11. Contato</h2>
            <p>
              Para exercer seus direitos ou tirar dúvidas sobre como tratamos seus dados, entre em contato pelo e-mail: <strong>{APP_CONFIG.SUPPORT_EMAIL}</strong>.
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

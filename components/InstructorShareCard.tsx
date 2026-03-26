import React, { useState } from 'react';
import { MessageCircle, Instagram, Copy, Share2, Check } from 'lucide-react';
import { useToast } from '../contexts/ToastContext';

interface InstructorShareCardProps {
  publicId: string;
  instructorName: string;
}

export const InstructorShareCard: React.FC<InstructorShareCardProps> = ({ publicId, instructorName }) => {
  const { addToast } = useToast();
  const [copied, setCopied] = useState(false);
  const [showInstaTip, setShowInstaTip] = useState(false);

  const profileUrl = `${window.location.origin}/#/i/${publicId}`;
  const whatsappMsg = encodeURIComponent(`Olá! Veja meus horários disponíveis e agende sua aula aqui: ${profileUrl}`);

  const handleCopy = () => {
    navigator.clipboard.writeText(profileUrl).then(() => {
      setCopied(true);
      addToast("Link copiado com sucesso!", 'success');
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: `Aulas com ${instructorName}`,
          text: 'Veja meus horários disponíveis e agende sua aula direto pelo app!',
          url: profileUrl,
        });
      } catch (err) {
        console.log('Error sharing:', err);
      }
    } else {
      handleCopy();
    }
  };

  return (
    <section className="bg-gradient-to-br from-blue-600 to-indigo-700 rounded-3xl p-6 shadow-xl shadow-blue-200 text-white overflow-hidden relative">
      {/* Decorative background element */}
      <div className="absolute -right-4 -top-4 w-24 h-24 bg-white/10 rounded-full blur-2xl" />
      
      <div className="relative z-10">
        <div className="flex items-center space-x-2 mb-2">
          <span className="text-xl">🚀</span>
          <h3 className="text-lg font-bold">Capture mais alunos</h3>
        </div>
        <p className="text-blue-50 text-sm mb-6 leading-relaxed">
          Sua agenda não para? Compartilhe seu link no WhatsApp e Instagram para facilitar os agendamentos.
        </p>

        <div className="grid grid-cols-1 gap-3">
          {/* WhatsApp Action */}
          <a 
            href={`https://wa.me/?text=${whatsappMsg}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between bg-white/10 hover:bg-white/20 transition-all p-4 rounded-2xl border border-white/20 group"
          >
            <div className="flex items-center space-x-3">
              <div className="bg-green-500 p-2 rounded-xl">
                <MessageCircle className="w-5 h-5 text-white" />
              </div>
              <span className="font-bold text-sm">Enviar no WhatsApp</span>
            </div>
            <Share2 className="w-4 h-4 text-white/50 group-hover:text-white transition-colors" />
          </a>

          {/* Instagram Action */}
          <div className="relative">
            <button 
              onClick={() => setShowInstaTip(!showInstaTip)}
              className="w-full flex items-center justify-between bg-white/10 hover:bg-white/20 transition-all p-4 rounded-2xl border border-white/20 group"
            >
              <div className="flex items-center space-x-3">
                <div className="bg-gradient-to-tr from-yellow-400 via-red-500 to-purple-600 p-2 rounded-xl">
                  <Instagram className="w-5 h-5 text-white" />
                </div>
                <span className="font-bold text-sm">Usar no Instagram</span>
              </div>
              <ChevronRight className={`w-4 h-4 text-white/50 transition-transform ${showInstaTip ? 'rotate-90' : ''}`} />
            </button>
            
            {showInstaTip && (
              <div className="mt-2 p-4 bg-white/5 rounded-xl border border-white/10 animate-in slide-in-from-top-2 duration-200">
                <p className="text-xs text-blue-100 leading-relaxed">
                  💡 <strong>Dica:</strong> Copie seu link e cole na <strong>Bio</strong> do seu Instagram. Assim, qualquer pessoa que visitar seu perfil poderá agendar aulas com você!
                </p>
                <button 
                  onClick={handleCopy}
                  className="mt-3 w-full bg-white text-blue-600 py-2 rounded-lg text-xs font-bold flex items-center justify-center space-x-2"
                >
                  <Copy className="w-3 h-3" />
                  <span>Copiar link para a Bio</span>
                </button>
              </div>
            )}
          </div>

          {/* Native Share / Copy Link */}
          <div className="flex space-x-2">
            <button 
              onClick={handleShare}
              className="flex-1 flex items-center justify-center space-x-2 bg-white text-blue-600 font-bold py-4 rounded-2xl shadow-lg active:scale-95 transition-all"
            >
              <Share2 className="w-5 h-5" />
              <span>Compartilhar</span>
            </button>
            
            <button 
              onClick={handleCopy}
              className="w-16 flex items-center justify-center bg-blue-500/30 hover:bg-blue-500/50 rounded-2xl border border-white/20 transition-all"
              title="Copiar link"
            >
              {copied ? <Check className="w-6 h-6 text-green-300" /> : <Copy className="w-6 h-6" />}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
};

const ChevronRight = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
  </svg>
);

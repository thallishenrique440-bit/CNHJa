import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';

export const InstructorShortLink: React.FC = () => {
  const { publicId } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const resolveLink = async () => {
      if (!publicId) {
        setError('ID inválido');
        return;
      }

      try {
        const { data, error } = await supabase
          .from('instructors')
          .select('id')
          .eq('public_id', publicId)
          .single();

        if (error || !data) {
          console.error('Instructor not found:', error);
          setError('Instrutor não encontrado');
          // Optional: Redirect to welcome after a delay
          setTimeout(() => navigate('/welcome'), 3000);
        } else {
          // Redirect to the actual profile route
          navigate(`/student/instructor/${data.id}`, { replace: true });
        }
      } catch (err) {
        console.error('Error resolving link:', err);
        setError('Erro ao processar link');
      }
    };

    resolveLink();
  }, [publicId, navigate]);

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-white p-4 text-center">
        <h2 className="text-xl font-bold text-gray-900 mb-2">Ops!</h2>
        <p className="text-gray-600 mb-4">{error}</p>
        <button 
          onClick={() => navigate('/welcome')}
          className="text-blue-600 font-medium hover:underline"
        >
          Ir para a página inicial
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-white">
      <div className="w-12 h-12 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mb-4"></div>
      <p className="text-gray-500 font-medium">Localizando instrutor...</p>
    </div>
  );
};

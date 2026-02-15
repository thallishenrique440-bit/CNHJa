import React, { useState, useEffect } from 'react';
import { InstructorBottomNav } from '../components/InstructorBottomNav';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { Modal } from '../components/Modal';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';

// DB Structure matches table 'instructor_packages'
interface Package {
  id: string;
  title: string;
  lesson_count: number;
  price: number; // Stored in cents
  description: string | null;
  includes_night: boolean;
  includes_exam: boolean;
  is_highlight: boolean;
}

export const InstructorPackages: React.FC = () => {
  const { session } = useAuth();
  const { addToast } = useToast();

  const [view, setView] = useState<'list' | 'create'>('list');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [packageToDelete, setPackageToDelete] = useState<string | null>(null);
  
  const [packages, setPackages] = useState<Package[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Form Data State
  const [formData, setFormData] = useState({
    title: '',
    lessonCount: '',
    price: '',
    description: '',
    includesNight: false,
    includesExam: false,
    isHighlight: false,
  });

  // --- HELPERS ---
  const formatCurrency = (cents: number) => {
    return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  };

  const parseCurrencyToCents = (str: string): number => {
    // Remove non-digits
    const clean = str.replace(/\D/g, '');
    return parseInt(clean) || 0;
  };

  const formatCurrencyInput = (value: string) => {
    const cents = parseCurrencyToCents(value);
    return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  };

  // --- FETCH DATA ---
  const fetchPackages = async () => {
    if (!session?.user) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('instructor_packages')
        .select('*')
        .eq('instructor_id', session.user.id)
        .order('price', { ascending: true }); // Show cheaper packages first usually

      if (error) throw error;
      setPackages(data || []);
    } catch (err: any) {
      console.error('Error fetching packages:', err);
      addToast("Erro ao carregar pacotes.", 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPackages();
  }, [session]);

  // --- FORM HANDLERS ---
  const resetForm = () => {
    setFormData({
      title: '',
      lessonCount: '',
      price: '',
      description: '',
      includesNight: false,
      includesExam: false,
      isHighlight: false,
    });
    setEditingId(null);
  };

  const handleCreateNew = () => {
    resetForm();
    setView('create');
  };

  const handleCancelForm = () => {
    resetForm();
    setView('list');
  };

  const handleEdit = (pkg: Package) => {
    setFormData({
      title: pkg.title,
      lessonCount: String(pkg.lesson_count),
      price: formatCurrency(pkg.price),
      description: pkg.description || '',
      includesNight: pkg.includes_night,
      includesExam: pkg.includes_exam,
      isHighlight: pkg.is_highlight,
    });
    setEditingId(pkg.id);
    setView('create');
  };

  const handleDelete = (id: string) => {
    setPackageToDelete(id);
  };

  const confirmDelete = async () => {
    if (!packageToDelete) return;
    try {
        const { error } = await supabase
            .from('instructor_packages')
            .delete()
            .eq('id', packageToDelete);

        if (error) throw error;

        setPackages(prev => prev.filter(p => p.id !== packageToDelete));
        addToast("Pacote excluído com sucesso.", 'success');
    } catch (err: any) {
        addToast("Erro ao excluir: " + err.message, 'error');
    } finally {
        setPackageToDelete(null);
    }
  };

  const handleSave = async () => {
    if (!session?.user) return;
    if (!formData.title || !formData.price || !formData.lessonCount) {
        addToast("Por favor, preencha os campos obrigatórios.", 'warning');
        return;
    }

    setSaving(true);
    const priceInCents = parseCurrencyToCents(formData.price);
    const count = parseInt(formData.lessonCount);

    try {
        // Business Rule: Only one "Best Package" allowed.
        // If this one is set to Highlight, un-highlight all others for this instructor first.
        if (formData.isHighlight) {
            await supabase
              .from('instructor_packages')
              .update({ is_highlight: false })
              .eq('instructor_id', session.user.id);
        }

        const payload = {
            instructor_id: session.user.id,
            title: formData.title,
            lesson_count: count,
            price: priceInCents,
            description: formData.description,
            includes_night: formData.includesNight,
            includes_exam: formData.includesExam,
            is_highlight: formData.isHighlight
        };

        if (editingId) {
            // UPDATE
            const { error } = await supabase
                .from('instructor_packages')
                .update(payload)
                .eq('id', editingId);
            
            if (error) throw error;
            addToast("Pacote atualizado!", 'success');
        } else {
            // INSERT
            const { error } = await supabase
                .from('instructor_packages')
                .insert(payload);
            
            if (error) throw error;
            addToast("Pacote criado!", 'success');
        }

        await fetchPackages(); // Refresh list to get updated highlights and sorts
        setView('list');
        resetForm();

    } catch (err: any) {
        console.error('Error saving package:', err);
        addToast("Erro ao salvar: " + err.message, 'error');
    } finally {
        setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-24 sm:max-w-md sm:mx-auto relative flex flex-col">
      
      {/* Header */}
      <div className="px-6 py-6 bg-white border-b border-gray-100 sticky top-0 z-10">
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Pacotes de aulas</h1>
            <p className="text-xs text-gray-500 mt-1">
              {view === 'list' ? 'Gerencie seus pacotes' : (editingId ? 'Editar pacote' : 'Novo pacote')}
            </p>
          </div>
          {view === 'list' ? (
             <button 
               onClick={handleCreateNew}
               className="text-sm font-semibold text-blue-600 bg-blue-50 px-3 py-2 rounded-lg hover:bg-blue-100 transition-colors"
             >
               + Criar
             </button>
          ) : (
            <button 
               onClick={handleCancelForm}
               className="text-sm font-medium text-gray-500 hover:text-gray-700 px-2 py-2"
             >
               Cancelar
             </button>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 px-4 py-4">
        
        {view === 'list' ? (
          <div className="space-y-4">
            {loading ? (
                <div className="flex justify-center py-10">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                </div>
            ) : packages.length === 0 ? (
               <div className="text-center py-10 text-gray-400 bg-white rounded-2xl border border-dashed border-gray-200">
                 <p className="text-3xl mb-2">📦</p>
                 <p>Nenhum pacote criado.</p>
                 <button onClick={handleCreateNew} className="text-blue-600 font-bold mt-2 text-sm">Criar o primeiro</button>
               </div>
            ) : (
              packages.map((pkg) => (
                <div key={pkg.id} className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 relative overflow-hidden transition-all hover:shadow-md">
                  {pkg.is_highlight && (
                    <div className="absolute top-0 right-0 bg-yellow-100 text-yellow-800 text-[10px] font-bold px-3 py-1 rounded-bl-xl uppercase tracking-wide">
                      ⭐ Melhor pacote
                    </div>
                  )}
                  
                  <div className="mb-3 pr-4">
                    <h3 className="font-bold text-gray-900 text-lg">{pkg.title}</h3>
                  </div>

                  <div className="flex items-baseline space-x-2 mb-4">
                    <span className="text-2xl font-bold text-blue-600">{formatCurrency(pkg.price)}</span>
                    <span className="text-sm text-gray-500">/ {pkg.lesson_count} aulas</span>
                  </div>

                  <div className="space-y-2 mb-4 border-t border-gray-50 pt-3">
                    <div className="flex items-center text-sm text-gray-600">
                      <span className={`w-4 h-4 mr-2 rounded-full flex items-center justify-center text-[10px] ${pkg.includes_night ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'}`}>
                        {pkg.includes_night ? '✓' : '✕'}
                      </span>
                      {pkg.includes_night ? 'Inclui aulas noturnas' : 'Não inclui aulas noturnas'}
                    </div>
                    <div className="flex items-center text-sm text-gray-600">
                      <span className={`w-4 h-4 mr-2 rounded-full flex items-center justify-center text-[10px] ${pkg.includes_exam ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'}`}>
                        {pkg.includes_exam ? '✓' : '✕'}
                      </span>
                      {pkg.includes_exam ? 'Acompanhamento no exame' : 'Sem acompanhamento no exame'}
                    </div>
                  </div>

                  {pkg.description && (
                    <p className="text-xs text-gray-400 leading-relaxed italic border-t border-gray-50 pt-3 mb-2">
                      "{pkg.description}"
                    </p>
                  )}

                  {/* Actions Footer */}
                  <div className="flex justify-end space-x-2 pt-2 border-t border-gray-50 mt-2">
                    <button 
                      onClick={() => handleEdit(pkg)}
                      className="flex items-center text-sm font-semibold text-blue-600 hover:text-blue-700 px-3 py-2 rounded-lg hover:bg-blue-50 transition-colors"
                    >
                      <svg className="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                      Editar
                    </button>
                    <button 
                      onClick={() => handleDelete(pkg.id)}
                      className="flex items-center text-sm font-semibold text-red-500 hover:text-red-600 px-3 py-2 rounded-lg hover:bg-red-50 transition-colors"
                    >
                      <svg className="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                      Excluir
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
          /* CREATE/EDIT FORM */
          <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 space-y-5 animate-fade-in-up">
            <Input 
              label="Nome do pacote"
              placeholder="Ex: Pacote Intensivo"
              value={formData.title}
              onChange={(e) => setFormData({...formData, title: e.target.value})}
            />

            <div className="flex space-x-4">
              <div className="w-1/3">
                 <Input 
                  label="Qtd. Aulas"
                  type="number"
                  placeholder="20"
                  value={formData.lessonCount}
                  onChange={(e) => setFormData({...formData, lessonCount: e.target.value})}
                />
              </div>
              <div className="flex-1">
                 <Input 
                  label="Preço Total (R$)"
                  type="text"
                  placeholder="R$ 0,00"
                  value={formData.price}
                  onChange={(e) => setFormData({...formData, price: formatCurrencyInput(e.target.value)})}
                />
              </div>
            </div>

            <div className="flex flex-col space-y-2 w-full text-left">
              <label className="text-sm font-semibold text-gray-700 ml-1">
                Descrição curta
              </label>
              <textarea
                className="w-full px-4 py-3.5 rounded-xl bg-gray-50 border border-gray-200 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-all duration-200 resize-none h-24"
                placeholder="Descreva os benefícios..."
                value={formData.description}
                onChange={(e) => setFormData({...formData, description: e.target.value})}
              />
            </div>

            <div className="space-y-3 pt-2">
              <label className="flex items-center space-x-3 p-3 border border-gray-100 rounded-xl hover:bg-gray-50 transition-colors cursor-pointer">
                <input 
                  type="checkbox"
                  className="w-5 h-5 text-blue-600 rounded focus:ring-blue-500 border-gray-300"
                  checked={formData.includesNight}
                  onChange={(e) => setFormData({...formData, includesNight: e.target.checked})}
                />
                <span className="text-gray-700 font-medium text-sm">Inclui aulas noturnas</span>
              </label>

              <label className="flex items-center space-x-3 p-3 border border-gray-100 rounded-xl hover:bg-gray-50 transition-colors cursor-pointer">
                <input 
                  type="checkbox"
                  className="w-5 h-5 text-blue-600 rounded focus:ring-blue-500 border-gray-300"
                  checked={formData.includesExam}
                  onChange={(e) => setFormData({...formData, includesExam: e.target.checked})}
                />
                <span className="text-gray-700 font-medium text-sm">Acompanhamento no exame</span>
              </label>

              <label className="flex items-center space-x-3 p-3 border border-yellow-100 bg-yellow-50 rounded-xl cursor-pointer">
                <input 
                  type="checkbox"
                  className="w-5 h-5 text-yellow-600 rounded focus:ring-yellow-500 border-yellow-300"
                  checked={formData.isHighlight}
                  onChange={(e) => setFormData({...formData, isHighlight: e.target.checked})}
                />
                <span className="text-yellow-800 font-bold text-sm">Marcar como melhor pacote</span>
              </label>
            </div>

            <div className="pt-4">
              <Button fullWidth onClick={handleSave} disabled={saving}>
                {saving ? 'Salvando...' : (editingId ? 'Salvar alterações' : 'Salvar pacote')}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={!!packageToDelete}
        onClose={() => setPackageToDelete(null)}
        title="Excluir pacote?"
        footer={
           <div className="flex space-x-3">
              <Button variant="outline" fullWidth onClick={() => setPackageToDelete(null)}>
                Cancelar
              </Button>
              <Button 
                fullWidth 
                onClick={confirmDelete}
                className="bg-red-600 hover:bg-red-700 focus:ring-red-500 shadow-none"
              >
                Excluir
              </Button>
            </div>
        }
      >
        <div className="text-center">
            <p className="text-sm text-gray-500">
              Tem certeza que deseja excluir este pacote? Esta ação não pode ser desfeita.
            </p>
        </div>
      </Modal>

      <InstructorBottomNav />
    </div>
  );
};
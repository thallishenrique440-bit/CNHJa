import React, { useState, useEffect } from 'react';
import { InstructorBottomNav } from '../components/InstructorBottomNav';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { Modal } from '../components/Modal';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';

// DB Structure matches table 'instructor_discounts'
interface DiscountRule {
  id: string;
  min_lessons: number;
  discount_percentage: number;
}

export const InstructorDiscounts: React.FC = () => {
  const { session } = useAuth();
  const { addToast } = useToast();

  const [view, setView] = useState<'list' | 'create'>('list');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [discountToDelete, setDiscountToDelete] = useState<string | null>(null);
  
  const [discounts, setDiscounts] = useState<DiscountRule[]>([]);
  const [categoryPrices, setCategoryPrices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Form Data State
  const [formData, setFormData] = useState({
    minLessons: '',
    discountPercentage: '',
  });

  // Helper for currency
  const formatCurrency = (valInCents: number) => {
    return (valInCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  };

  // --- FETCH DATA ---
  const fetchDiscounts = async () => {
    if (!session?.user) return;
    setLoading(true);
    try {
      // Fetch instructor categories for real prices
      const { data: catData } = await supabase
        .from('instructor_categories')
        .select('*')
        .eq('instructor_id', session.user.id);
        
      if (catData) {
          setCategoryPrices(catData);
      }

      const { data, error } = await supabase
        .from('instructor_discounts')
        .select('*')
        .eq('instructor_id', session.user.id)
        .order('min_lessons', { ascending: true });

      if (error) throw error;
      setDiscounts(data || []);
    } catch (err: any) {
      console.error('Error fetching discounts:', err);
      addToast("Erro ao carregar descontos.", 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDiscounts();
  }, [session]);

  // --- FORM HANDLERS ---
  const resetForm = () => {
    setFormData({
      minLessons: '',
      discountPercentage: '',
    });
    setEditingId(null);
  };

  const handleCreateNew = () => {
    if (discounts.length >= 2) {
      addToast("Você já atingiu o limite de 2 regras de desconto.", 'warning');
      return;
    }
    resetForm();
    setView('create');
  };

  const handleCancelForm = () => {
    resetForm();
    setView('list');
  };

  const handleEdit = (rule: DiscountRule) => {
    setFormData({
      minLessons: String(rule.min_lessons),
      discountPercentage: String(rule.discount_percentage),
    });
    setEditingId(rule.id);
    setView('create');
  };

  const handleDelete = (id: string) => {
    setDiscountToDelete(id);
  };

  const confirmDelete = async () => {
    if (!discountToDelete) return;
    try {
        const { error } = await supabase
            .from('instructor_discounts')
            .delete()
            .eq('id', discountToDelete);

        if (error) throw error;

        setDiscounts(prev => prev.filter(d => d.id !== discountToDelete));
        addToast("Regra excluída com sucesso.", 'success');
    } catch (err: any) {
        addToast("Erro ao excluir: " + err.message, 'error');
    } finally {
        setDiscountToDelete(null);
    }
  };

  const handleSave = async () => {
    if (!session?.user) return;
    if (!formData.minLessons || !formData.discountPercentage) {
        addToast("Por favor, preencha todos os campos.", 'warning');
        return;
    }

    setSaving(true);
    const minLessons = parseInt(formData.minLessons);
    const discountPercentage = parseInt(formData.discountPercentage);

    if (isNaN(minLessons) || minLessons < 1) {
        addToast("Quantidade mínima de aulas inválida.", 'warning');
        setSaving(false);
        return;
    }

    if (isNaN(discountPercentage) || discountPercentage < 1 || discountPercentage > 100) {
        addToast("Porcentagem de desconto inválida.", 'warning');
        setSaving(false);
        return;
    }

    try {
        const payload = {
            instructor_id: session.user.id,
            min_lessons: minLessons,
            discount_percentage: discountPercentage,
        };

        if (editingId) {
            // UPDATE
            const { error } = await supabase
                .from('instructor_discounts')
                .update(payload)
                .eq('id', editingId);
            
            if (error) throw error;
            addToast("Regra atualizada!", 'success');
        } else {
            // INSERT
            // Double check limit before insert
            if (discounts.length >= 2) {
                 throw new Error("Limite de 2 regras atingido.");
            }

            const { error } = await supabase
                .from('instructor_discounts')
                .insert(payload);
            
            if (error) throw error;
            addToast("Regra criada!", 'success');
        }

        await fetchDiscounts(); 
        setView('list');
        resetForm();

    } catch (err: any) {
        console.error('Error saving discount:', err);
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
            <h1 className="text-xl font-bold text-gray-900">Descontos</h1>
            <p className="text-xs text-gray-500 mt-1">
              {view === 'list' ? 'Configure descontos progressivos' : (editingId ? 'Editar regra' : 'Nova regra')}
            </p>
          </div>
          {view === 'list' ? (
             <button 
               onClick={handleCreateNew}
               disabled={discounts.length >= 2}
               className={`text-sm font-semibold px-3 py-2 rounded-lg transition-colors ${
                 discounts.length >= 2 
                   ? 'bg-gray-100 text-gray-400 cursor-not-allowed' 
                   : 'text-blue-600 bg-blue-50 hover:bg-blue-100'
               }`}
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
            ) : discounts.length === 0 ? (
               <div className="text-center py-10 text-gray-400 bg-white rounded-2xl border border-dashed border-gray-200">
                 <p className="text-3xl mb-2">🏷️</p>
                 <p>Nenhuma regra de desconto.</p>
                 <button onClick={handleCreateNew} className="text-blue-600 font-bold mt-2 text-sm">Criar a primeira</button>
               </div>
            ) : (
              discounts.map((rule) => {
                return (
                  <div key={rule.id} className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 relative overflow-hidden transition-all hover:shadow-md">
                    
                    <div className="flex justify-between items-start mb-4">
                      <div>
                        <div className="flex items-baseline space-x-2">
                          <span className="text-2xl font-bold text-green-600">{rule.discount_percentage}% OFF</span>
                        </div>
                        <p className="text-sm text-gray-600 font-medium mt-1">
                          A partir de <span className="font-bold text-gray-900">{rule.min_lessons} aulas</span>
                        </p>
                      </div>

                      {/* Actions */}
                      <div className="flex space-x-2">
                        <button 
                          onClick={() => handleEdit(rule)}
                          className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                        >
                          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </button>
                        <button 
                          onClick={() => handleDelete(rule.id)}
                          className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                        >
                          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    </div>

                    {/* 2x2 Preview Grid */}
                    <div className="grid grid-cols-2 gap-3 pt-4 border-t border-gray-50">
                      {['A', 'B'].map(cat => {
                        const catData = categoryPrices.find(c => c.category === cat);
                        if (!catData) return null;
                        const pct = rule.discount_percentage / 100;

                        return (
                          <React.Fragment key={cat}>
                            <div className="bg-gray-50 p-4 rounded-xl border border-gray-100">
                              <p className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-1.5">
                                {cat === 'A' ? '🏍️ Moto • Diurno' : '🚗 Carro • Diurno'}
                              </p>
                              <div className="flex flex-col">
                                <span className="text-base font-bold text-gray-900 leading-tight">
                                  {formatCurrency(catData.day_price * (1 - pct))}
                                  <span className="text-[10px] font-normal text-gray-500 ml-1">/ aula</span>
                                </span>
                                <div className="flex items-center text-[10px] text-gray-400 mt-0.5">
                                  <span className="line-through">{formatCurrency(catData.day_price)}</span>
                                  <span className="ml-1">(- {formatCurrency(catData.day_price * pct)})</span>
                                </div>
                              </div>
                            </div>
                            <div className="bg-gray-50 p-4 rounded-xl border border-gray-100">
                              <p className="text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-1.5">
                                {cat === 'A' ? '🏍️ Moto • Noturno' : '🚗 Carro • Noturno'}
                              </p>
                              <div className="flex flex-col">
                                <span className="text-base font-bold text-gray-900 leading-tight">
                                  {formatCurrency(catData.night_price * (1 - pct))}
                                  <span className="text-[10px] font-normal text-gray-500 ml-1">/ aula</span>
                                </span>
                                <div className="flex items-center text-[10px] text-gray-400 mt-0.5">
                                  <span className="line-through">{formatCurrency(catData.night_price)}</span>
                                  <span className="ml-1">(- {formatCurrency(catData.night_price * pct)})</span>
                                </div>
                              </div>
                            </div>
                          </React.Fragment>
                        );
                      })}
                    </div>
                  </div>
                );
              })
            )}
            
            {discounts.length > 0 && discounts.length < 2 && (
               <p className="text-center text-xs text-gray-400 mt-4">
                 Você pode adicionar mais {2 - discounts.length} regra.
               </p>
            )}
          </div>
        ) : (
          /* CREATE/EDIT FORM */
          <div className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 space-y-5 animate-fade-in-up">
            
            <div className="bg-blue-50 p-4 rounded-xl border border-blue-100">
               <p className="text-sm text-blue-800 leading-relaxed">
                 Configure até 2 descontos automáticos para incentivar seus alunos a comprarem mais aulas de uma vez.
               </p>
            </div>

            <div className="space-y-4">
               <div className="relative">
                 <label className="block text-sm font-medium text-gray-700 mb-1">
                    Mínimo de aulas para aplicar
                 </label>
                 <div className="relative">
                    <input
                      type="number"
                      className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-gray-900 placeholder-gray-400"
                      placeholder="Ex: 5 aulas"
                      value={formData.minLessons}
                      onChange={(e) => setFormData({...formData, minLessons: e.target.value})}
                    />
                    {formData.minLessons && (
                        <span className="absolute right-4 top-1/2 transform -translate-y-1/2 text-gray-400 font-medium pointer-events-none">
                            aulas
                        </span>
                    )}
                 </div>
                 <p className="text-xs text-gray-400 mt-1 ml-1">
                   O aluno precisa selecionar pelo menos essa quantidade.
                 </p>
               </div>

               <div className="relative">
                 <label className="block text-sm font-medium text-gray-700 mb-1">
                    Porcentagem de Desconto (%)
                 </label>
                 <div className="relative">
                    <input
                      type="number"
                      className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-gray-900 placeholder-gray-400"
                      placeholder="Ex: 10%"
                      value={formData.discountPercentage}
                      onChange={(e) => setFormData({...formData, discountPercentage: e.target.value})}
                    />
                    {formData.discountPercentage && (
                        <span className="absolute right-4 top-1/2 transform -translate-y-1/2 text-gray-400 font-medium pointer-events-none">
                            %
                        </span>
                    )}
                 </div>
                 <p className="text-xs text-gray-400 mt-1 ml-1">
                  Desconto aplicado sobre o valor total.
                </p>
              </div>

              {/* Real-time Preview 2x2 */}
              {formData.discountPercentage && parseInt(formData.discountPercentage) > 0 && (
                <div className="pt-2">
                  <p className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-3">Preview dos preços com desconto:</p>
                  <div className="grid grid-cols-2 gap-4">
                    {['A', 'B'].map(cat => {
                      const catData = categoryPrices.find(c => c.category === cat);
                      if (!catData) return null;
                      const pct = parseInt(formData.discountPercentage) / 100;

                      return (
                        <React.Fragment key={cat}>
                          <div className="bg-green-50/50 p-4 rounded-xl border border-green-100">
                            <p className="text-[10px] font-bold text-green-800 uppercase mb-1.5">
                              {cat === 'A' ? '🏍️ Moto • Diurno' : '🚗 Carro • Diurno'}
                            </p>
                            <div className="flex flex-col">
                              <span className="text-base font-bold text-green-900 leading-tight">
                                {formatCurrency(catData.day_price * (1 - pct))}
                                <span className="text-[10px] font-normal text-green-700/70 ml-1">/ aula</span>
                              </span>
                              <div className="flex items-center text-[10px] text-green-700/60 mt-0.5">
                                <span className="line-through">{formatCurrency(catData.day_price)}</span>
                                <span className="ml-1">(- {formatCurrency(catData.day_price * pct)})</span>
                              </div>
                            </div>
                          </div>
                          <div className="bg-green-50/50 p-4 rounded-xl border border-green-100">
                            <p className="text-[10px] font-bold text-green-800 uppercase mb-1.5">
                              {cat === 'A' ? '🏍️ Moto • Noturno' : '🚗 Carro • Noturno'}
                            </p>
                            <div className="flex flex-col">
                              <span className="text-base font-bold text-green-900 leading-tight">
                                {formatCurrency(catData.night_price * (1 - pct))}
                                <span className="text-[10px] font-normal text-green-700/70 ml-1">/ aula</span>
                              </span>
                              <div className="flex items-center text-[10px] text-green-700/60 mt-0.5">
                                <span className="line-through">{formatCurrency(catData.night_price)}</span>
                                <span className="ml-1">(- {formatCurrency(catData.night_price * pct)})</span>
                              </div>
                            </div>
                          </div>
                        </React.Fragment>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="pt-4">
              <Button fullWidth onClick={handleSave} disabled={saving}>
                {saving ? 'Salvando...' : (editingId ? 'Salvar regra' : 'Criar regra')}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={!!discountToDelete}
        onClose={() => setDiscountToDelete(null)}
        title="Excluir regra?"
        footer={
           <div className="flex space-x-3">
              <Button variant="outline" fullWidth onClick={() => setDiscountToDelete(null)}>
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
              Tem certeza que deseja excluir esta regra de desconto?
            </p>
        </div>
      </Modal>

      <InstructorBottomNav />
    </div>
  );
};
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

Deno.serve(async (req) => {
  // 1. Security check: Validate Authorization header
  const authHeader = req.headers.get('Authorization')
  const cronSecret = Deno.env.get('CRON_SECRET')

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.error("❌ Unauthorized: Invalid CRON_SECRET")
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    console.log("⏰ Starting auto-complete-lessons job...")

    // 2. Call RPC to auto-complete lessons
    const { data: updatedCount, error } = await supabaseAdmin
      .rpc('auto_complete_lessons')

    if (error) {
      console.error("❌ Error auto-completing lessons:", error)
      throw error
    }

    const count = updatedCount || 0
    console.log(`✅ Auto-completed ${count} lessons.`)

    return new Response(
      JSON.stringify({ 
        message: 'Job completed', 
        auto_completed_count: count
      }),
      { headers: { 'Content-Type': 'application/json' } }
    )

  } catch (error: any) {
    console.error("🚨 Critical Job Error:", error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})

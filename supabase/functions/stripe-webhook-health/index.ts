// Função ultra-leve para diagnóstico de conectividade
// Sem dependências externas pesadas para garantir boot instantâneo

Deno.serve(async (req: Request) => {
  const signature = req.headers.get("Stripe-Signature") || "none";
  const userAgent = req.headers.get("User-Agent") || "unknown";

  console.log(`🩺 Health Check recebido de: ${userAgent}`);
  console.log(`🔑 Assinatura presente: ${signature !== "none"}`);

  return new Response(
    JSON.stringify({
      status: "ok",
      message: "Connectivity confirmed",
      received_signature: signature !== "none",
      timestamp: new Date().toISOString(),
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
});

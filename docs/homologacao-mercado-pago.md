# Food Truck Federal · homologação comercial

O site público opera em **DEMO**. A integração usa o Checkout Pro via Preferências. A retirada continua no balcão da Kombi.

## Como o pagamento entra no pedido

1. O Worker recalcula os preços a partir do catálogo e grava a reserva no D1 com a chave da tentativa de checkout. O limite por janela de 15 minutos é verificado no mesmo comando que insere o pedido. A reserva de pagamento vale cinco minutos.
2. O botão **Abrir Mercado Pago** solicita a preferência ao servidor. O Worker confere a identidade e o tipo da conta vendedora. Grava a tentativa antes do POST e libera apenas um link HTTPS correspondente ao ambiente e à preferência. Se perder a resposta, procura pela referência do pedido. Uma busca vazia mantém a tentativa em aberto até o prazo da reserva.
3. As três URLs de retorno levam ao acompanhamento. A página descarta os parâmetros recebidos. O webhook valida HMAC-SHA256 no servidor e usa apenas o ID assinado para consultar o pagamento na API.
4. Antes de liberar o preparo, o Worker confere modo, conta recebedora, referência do pedido, valor em centavos, moeda BRL e vínculo com a preferência pela ordem comercial. A aprovação só ocupa uma reserva ainda ativa. A confirmação operacional por código continua separada.
5. Aprovações tardias e cobranças duplicadas geram uma solicitação de estorno. Em cancelamentos de pedidos pagos, a ação do painel também registra a solicitação. O processador envia o estorno com uma chave idempotente e confirma a devolução integral após consultar a API. Um reembolso parcial, uma contestação ou um estado divergente exige conferência da operação.
6. O D1 registra IDs, origem da conciliação, estado anterior, estado posterior e resultado. A fila, a capacidade e as métricas são filtradas por modo. Os registros anteriores à migração entram como DEMO.

## Configuração no servidor

| Chave | Uso |
|---|---|
| `FEDERAL_MODE` | `demo` por padrão. Use `teste` durante a homologação. |
| `FEDERAL_PUBLIC_ORIGIN` | Origem HTTPS canônica da instância em homologação, sem barra final. |
| `FEDERAL_MP_TEST_ACCESS_TOKEN`, `FEDERAL_MP_TEST_WEBHOOK_SECRET`, `FEDERAL_MP_TEST_COLLECTOR_ID` | Credencial e assinatura da aplicação no ambiente de teste e ID do vendedor de teste. |
| `FEDERAL_MP_PROD_ACCESS_TOKEN`, `FEDERAL_MP_PROD_WEBHOOK_SECRET`, `FEDERAL_MP_PROD_COLLECTOR_ID` | Credencial, assinatura e conta recebedora do ambiente produtivo. |
| `FEDERAL_RECONCILIATION_SECRET` | Segredo exclusivo do agendador HTTPS. Use uma sequência aleatória de 32 a 256 caracteres no alfabeto base64url ou hexadecimal. |
| `FEDERAL_PRODUCTION_APPROVAL` | A produção exige `HOMOLOGADO_E_AUTORIZADO`, dados comerciais conferidos e o segredo de conciliação. Configure o valor somente ao concluir o checklist. |
| `FEDERAL_OPERATORS` | E-mails autorizados, separados por vírgula ou quebra de linha. A forma `email\|id-da-conta-no-site` vincula também o ID de sessão fornecido pelo Sites. Entradas anteriores só com e-mail continuam válidas. |

Cadastre tokens e assinaturas nos segredos de execução do Sites. Guarde o segredo do agendador também no serviço que fará a chamada. Use o ID do vendedor de teste mostrado em **Suas integrações → Contas de teste**. O formato do token por si só é insuficiente para distinguir ambientes.

Configure o evento **Pagamentos** no Mercado Pago em `/api/mercado-pago/webhook/teste` para TESTE e em `/api/mercado-pago/webhook/producao` para PRODUÇÃO, sempre com a origem HTTPS da respectiva instância. O Checkout Pro usa `init_point` em ambos os modos. A conta vendedora de teste é conferida antes da criação da preferência. Confirme o formato retornado pela API, o vínculo com a ordem comercial e o valor de `live_mode` na homologação. A documentação do Mercado Pago indica que pagamentos com credenciais de teste podem exigir a simulação de entrega no painel do provedor para validar o webhook. Teste também a busca de pagamentos sem webhook.

## Conciliação e incidentes

- O painel oferece **Métricas → Conciliar pagamentos** fora do modo DEMO. A rotina recupera notificações pendentes, procura pagamentos pela referência e envia estornos solicitados. O endpoint administrativo também aceita `POST /api/admin/conciliar/{id-do-pedido}` para uma investigação pontual.
- A rotina automática usa `POST /api/mercado-pago/conciliar/{teste|producao}` com `Authorization: Bearer` e o segredo do agendador. A chamada processa um lote limitado. Durante a homologação, configure e meça a frequência necessária para cumprir a reserva de cinco minutos com a fila esperada. Verifique chamadas bem-sucedidas, alertas de falha e a recuperação com o painel fechado. O Sites atual ainda não tem um agendamento financeiro configurado.
- Se uma aprovação chegar após expirar ou cancelar a reserva, o pedido fica cancelado e o financeiro passa a **Estorno solicitado**. O preparo permanece indisponível. Um pedido já retirado conserva seu histórico de entrega caso receba um estorno ou contestação.
- Use o ID exibido em **Métricas → Conciliação Mercado Pago** para conferir estornos ou transações em revisão na conta vendedora. Em caso de divergência ou interrupção, o responsável técnico pode conferir `payment_events` no D1. Para expor alertas opcionais de fraude ou contestação, homologue o tratamento específico antes de ativar esses tópicos. A rotina atual trata os estados da API de pagamentos.
- A consulta automática reavalia pedidos recentes com frequência decrescente por até 120 dias. Eventos assinados continuam sendo aceitos para pedidos antigos enquanto as credenciais correspondentes estiverem configuradas. A trilha permanece no D1. Confirme no provedor o prazo aplicável para reembolsos e contestações.
- Em incidente, use **Pausar pedidos** para parar novas reservas e manter a fila existente. Preserve as credenciais e a conciliação enquanto houver pagamentos pendentes. Se houver suspeita sobre as credenciais, trate a rotação no painel do provedor e valide a conexão novamente.

## Para a proprietária

1. Abra **Painel da proprietária** no celular e entre com sua própria conta ChatGPT. O responsável pelo Sites inclui apenas o e-mail dessa conta na lista de operadores. Se já estiver em outra conta, use **Trocar de conta**. Em caso de sessão expirada, use **Reabrir painel**.
2. Em **Operação**, confira horários, limite por janela, antecedência e os dados comerciais. Publique apenas as informações que você conferiu. Em **Catálogo**, confirme os preços, variantes, adicionais e disponibilidade.
3. Faça o ensaio com a equipe em TESTE. Confira que o pedido aguarda o pagamento e que o preparo só é liberado após a confirmação. Teste também a pausa, um cancelamento e o acompanhamento do estorno. Em caso de dificuldade, anote a hora e o número exibido do pedido.
4. Dê a autorização para vendas reais somente depois de revisar o checklist com a equipe.

Se a proprietária não conseguir entrar pelo ChatGPT Sites, mantenha o painel restrito. A alternativa de hospedagem deve usar identidade gerenciada, por exemplo Cloudflare Access para uma origem administrativa protegida, com validação de token no servidor e lista de operadores. A loja pública pode continuar em uma origem separada. Essa alternativa requer avaliação e homologação próprias.

## Checklist de ativação

- [ ] Conta Mercado Pago da proprietária concluída, com a conta recebedora conferida.
- [ ] Credenciais de TESTE e PRODUÇÃO configuradas no ambiente certo e guardadas no servidor.
- [ ] Webhook de pagamentos homologado, com verificação de assinatura, retorno e reentrega.
- [ ] Pagamentos com comprador de teste validados, incluindo aprovação, recusa e pendência.
- [ ] Proprietária conseguiu acessar e operar o painel no celular dela.
- [ ] Preços, disponibilidade, horários, capacidade, antecedência, contato, endereço, identificação e políticas aprovados.
- [ ] Cancelamento, estorno confirmado, aprovação tardia e recuperação sem webhook validados em TESTE. Agendamento e alertas verificados com o painel fechado.
- [ ] Autorização explícita da proprietária registrada para receber pedidos reais.

## Validação local da Sprint 4

| Teste | Resultado |
|---|---|
| `npm run build` e `npx --no-install tsc --noEmit` | Build e TypeScript passaram. |
| `npm run lint` | Zero erros e 11 avisos sobre imagens `<img>`. |
| `node scripts/qa-federal.mjs` | Passou com 38 produtos, idempotência, autorização, migrações, pausa, estoque, D1, R2 e fluxo até retirada. O pico de 24 requisições gerou nove novas reservas, sete conflitos por lotação e oito reenvios da reserva original. A janela ficou com 10 pedidos contando a reserva inicial. |
| `node scripts/qa-mercado-pago.mjs` | Passou em Worker local com provedor simulado. Seis solicitações concorrentes de preferência geraram um POST. Doze pedidos disputaram uma vaga e apenas um a reservou. Cobriu assinatura inválida, entregas duplicadas e fora de ordem, divergências, aprovação tardia, estorno, falhas de comunicação, conciliação e bloqueio da produção. |
| Navegador móvel a 360 e 390 px | Em DEMO, pedido personalizado, preparo, retirada por código, acompanhamento e métricas. Em TESTE local, retirada agendada, reserva sem liberação de preparo, link de pagamento na interface e recuperação após fim de sessão. |

Os dados e as respostas financeiras foram isolados no ambiente de teste. A homologação com contas do Mercado Pago e o acesso da proprietária pelo celular dela continuam pendentes.

## Referências oficiais

- [Checkout Pro via Preferências](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-preferences/create-payment-preference)
- [URLs de retorno](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-preferences/configure-back-urls)
- [Webhooks de pagamento](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-preferences/payment-notifications)
- [Consulta de pagamento](https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-pro/get-payment/get)
- [Consulta de ordem comercial](https://www.mercadopago.com.br/developers/en/reference/online-payments/checkout-pro-preferences/merchant-orders/get-merchant-order/get)
- [Estorno e chave idempotente](https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-pro/create-refund/post)
- [Contas de teste](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-preferences/test-accounts)
- [Redirecionamento e contas de teste no Checkout Pro](https://github.com/mercadopago/mercadopago-claude-marketplace/blob/main/plugins/mercadopago/skills/mp-integrate/SKILL.md)
- [Validação de tokens do Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Decreto 7.962/2013, informações ao consumidor em comércio eletrônico](https://www.planalto.gov.br/ccivil_03/_ato2011-2014/2013/decreto/d7962.htm)

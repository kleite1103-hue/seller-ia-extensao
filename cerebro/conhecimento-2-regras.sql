-- SELLER.IA · REGRAS. Rodar DEPOIS de conhecimento-1-tabela.sql

-- ============================================================
-- LIMIARES — os numeros do Metodo Efeito Vendas
-- ============================================================
insert into conhecimento (dominio, chave, condicao, veredito, fonte, observacao) values
('limiar','ctr_minimo',
 '{"valor":1.8,"unidade":"pct"}',
 '{"rotulo":"CTR minimo saudavel"}',
 'Metodo Efeito Vendas',
 'Abaixo disso o card nao chama clique. Regra de mercado, divulgavel.'),

('limiar','visitas_minimas_julgamento',
 '{"valor":100,"unidade":"visitantes"}',
 '{"rotulo":"Piso de volume para julgar"}',
 'Metodo Efeito Vendas',
 'Com menos visita qualquer percentual engana. 1 venda em 3 visitas = 33% e nao significa nada.'),

('limiar','roas_piso_padrao',
 '{"valor":8,"unidade":"x"}',
 '{"rotulo":"ROAS minimo quando a margem e desconhecida"}',
 'Metodo Efeito Vendas',
 'Vale como padrao. Quando a margem existe, o piso real (1/margem) tem prioridade.'),

('limiar','concentracao_produto',
 '{"valor":30,"unidade":"pct"}',
 '{"rotulo":"Concentracao de faturamento num produto"}',
 'Metodo Efeito Vendas',
 'Acima disso a loja depende do produto. Acima de 40% vira alerta severo no relatorio.'),

('limiar','degrau_comissao',
 '{"faixas":[{"ate":79.99,"pct":20,"fixo":4},{"ate":99.99,"pct":14,"fixo":16},{"ate":199.99,"pct":14,"fixo":20},{"ate":null,"pct":14,"fixo":26}]}',
 '{"rotulo":"Tabela de comissao Shopee"}',
 'Tabela publica Shopee',
 'Divulgavel. O insight e que passar de R$80 pode aumentar a sobra.'),

('limiar','tacos_faixas',
 '{"reinvestir_abaixo":8,"erosao_acima":12,"unidade":"pct"}',
 '{"rotulo":"Faixas de TACOS"}',
 'Metodo Efeito Vendas', null),

('limiar','dependencia_ads',
 '{"alerta":50,"severo":95,"unidade":"pct"}',
 '{"rotulo":"Dependencia de Shopee Ads"}',
 'Metodo Efeito Vendas',
 'Loja que vive de Ads para quando o Ads para.')
on conflict (dominio, chave, versao) do nothing;

-- ============================================================
-- REGRAS DE PRODUTO — ordem importa, roda de cima para baixo
-- ============================================================
insert into conhecimento (dominio, chave, prioridade, condicao, veredito, fonte) values
('produto','sem_visita', 10,
 '{"visitas_menor_que":100}',
 '{"nivel":"cinza","titulo":"Visitas insuficientes para julgar","texto":"Recebeu {visitas} visitantes no periodo. Com menos de 100, qualquer percentual vira ruido.","passos":["Traga visita antes de tirar conclusao deste produto."]}',
 'Metodo Efeito Vendas'),

('produto','clique_baixo', 20,
 '{"ctr_menor_que":1.8}',
 '{"nivel":"vermelho","titulo":"Aparece na vitrine e recebe pouco clique","texto":"De cada 100 pessoas que viram na busca, {ctr} clicaram. O normal e ao menos 2.","passos":["Troque a primeira foto","Revise o comeco do titulo","Compare o preco no card com os primeiros da busca"]}',
 'Metodo Efeito Vendas'),

('produto','nao_converte', 30,
 '{"ctr_maior_igual":1.8,"conversao_menor_que":1}',
 '{"nivel":"vermelho","titulo":"Recebe clique e nao vende","texto":"O card funciona: {ctr} de cada 100 clicam. Mas de cada 100 que entram na pagina, menos de 1 compra.","passos":["Abra a pagina no celular","Compare preco com o concorrente da mesma busca","Verifique variacao sem estoque","Responda as avaliacoes pendentes"]}',
 'Metodo Efeito Vendas'),

('produto','rejeicao_alta', 40,
 '{"rejeicao_maior_igual":70}',
 '{"nivel":"amarelo","titulo":"A maioria sai sem olhar nada","texto":"De cada 100 que entram, {rejeicao} saem sem clicar em nada.","passos":["Confira se a primeira foto e o titulo descrevem o que a pessoa encontra ao entrar"]}',
 'Metodo Efeito Vendas'),

('produto','concentracao', 50,
 '{"fatia_maior_igual":30}',
 '{"nivel":"amarelo","titulo":"{fatia}% do faturamento vem deste produto","texto":"Se ele perder posicao, sair de estoque ou ganhar um concorrente mais barato, a loja perde {fatia}% de uma vez.","passos":["Nao mexa neste sem motivo","Coloque esforco no segundo colocado"]}',
 'Metodo Efeito Vendas'),

('produto','faixa_comissao', 60,
 '{"ticket_menor_que":80,"ticket_maior_que":0}',
 '{"nivel":"amarelo","titulo":"Preco na faixa de comissao mais cara","texto":"Cada pedido sai a {ticket}. Ate R$79,99 a Shopee cobra 20% + R$4. Passando de R$80 cai para 14% + R$16.","passos":["Monte um kit ou combo que passe de R$80"]}',
 'Tabela publica Shopee'),

('produto','converte_sem_ads', 70,
 '{"conversao_maior_igual":2,"tem_ads":false}',
 '{"nivel":"verde","titulo":"Vende bem sem nenhum anuncio","texto":"De cada 100 que entram, {conversao} compram, sem investimento nenhum.","passos":["E o produto mais barato para comecar a anunciar: voce paga por visita que ja sabe converter"]}',
 'Metodo Efeito Vendas'),

('produto','converte_com_ads', 80,
 '{"conversao_maior_igual":2,"tem_ads":true}',
 '{"nivel":"verde","titulo":"Vende bem e ja tem anuncio","texto":"De cada 100 que entram, {conversao} compram.","passos":["Suba o orcamento em 20% e reavalie em 7 dias, uma mudanca por vez"]}',
 'Metodo Efeito Vendas')
on conflict (dominio, chave, versao) do nothing;

-- ============================================================
-- AS 8 REGRAS DE DIAGNOSTICO DA PROPRIA SHOPEE
-- parametros CONFIRMADOS na rota mydata/product/diagnosis/items_count
-- nome: PENDENTE — esta no painel dela, nao na API
-- ============================================================
insert into conhecimento (dominio, chave, condicao, veredito, fonte, observacao) values
('shopee_diagnostico','metric_10000',
 '{"metric_id":10000,"janela_dias":7,"limite_pct":50,"pedidos_minimos":null,"d3":"variacao"}',
 '{"nivel":"vermelho","titulo":"Queda forte na semana","texto":"A Shopee marcou este produto por queda acima de 50% em 7 dias: de {d1} para {d2}.","passos":["Verifique estoque","Verifique se saiu de alguma campanha","Compare o preco com os primeiros da busca"]}',
 'mydata/product/diagnosis/items_count',
 'NOME PENDENTE. d3 e variacao percentual, nao taxa. Valores tem formato de dinheiro.'),

('shopee_diagnostico','metric_10003',
 '{"metric_id":10003,"janela_dias":45,"limite_pct":10,"pedidos_minimos":2,"d3":"taxa"}',
 '{"nivel":"amarelo","titulo":"Alerta de problema por pedido","texto":"{d2} de {d1} pedidos deram problema em 45 dias, ou {d3}%.","passos":["Verifique se o problema esta em uma variacao especifica","Grade, cor e estoque trocado sao as causas mais comuns"]}',
 'mydata/product/diagnosis/items_count',
 'NOME PENDENTE. Provavel taxa de devolucao ou cancelamento. Ha versao por SKU: mydata/v3/product/diagnosis/sku.'),

('shopee_diagnostico','metric_10004',
 '{"metric_id":10004,"janela_dias":15,"limite_pct":5,"pedidos_minimos":10,"d3":"taxa"}',
 '{"nivel":"vermelho","titulo":"Alerta com limite apertado","texto":"Regra que exige ao menos 10 pedidos e tolera so 5%. Produto marcado aqui merece olhar antes dos outros.","passos":["Priorize este produto na fila"]}',
 'mydata/product/diagnosis/items_count',
 'NOME PENDENTE. Limite baixo com volume alto indica metrica que vira penalidade.'),

('shopee_diagnostico','metric_10002',
 '{"metric_id":10002,"janela_dias":7,"limite_pct":null,"pedidos_minimos":null}',
 '{"nivel":"amarelo","titulo":"Condicao sinalizada pela Shopee","texto":"Regra sem limite numerico: e uma condicao verdadeira ou falsa, nao uma taxa.","passos":["Abrir a tela de Diagnostico de Produto para ver o motivo"]}',
 'mydata/product/diagnosis/items_count',
 'NOME PENDENTE. Sem limite = condicao (sem estoque, sem trafego, cadastro incompleto).'),

('shopee_diagnostico','metric_10006',
 '{"metric_id":10006,"janela_dias":7,"limite_pct":null,"pedidos_minimos":null,"o_others":2}',
 '{"nivel":"amarelo","titulo":"Condicao sinalizada pela Shopee","texto":"Regra sem limite numerico, com um segundo parametro que as outras nao tem.","passos":["Abrir a tela de Diagnostico de Produto para ver o motivo"]}',
 'mydata/product/diagnosis/items_count',
 'NOME PENDENTE. Tem o_others=2, unico entre as oito.')
on conflict (dominio, chave, versao) do nothing;

-- ============================================================
-- OS 4 EIXOS DE VEREDITO DE CAMPANHA
-- so bidding_v2 foi capturado com problema; os outros 3 nunca falharam
-- ============================================================
insert into conhecimento (dominio, chave, condicao, veredito, fonte, observacao) values
('shopee_verdict','bidding_v2',
 '{"eixo":"bidding_v2","entrega_alvo":true,"campos":["current_roi_two_target","suggested_roi_two_target","estimate_gmv_pct","estimate_order_pct"]}',
 '{"nivel":"vermelho","titulo":"A Shopee considera sua meta alta demais","texto":"Sua meta e {meta_atual}x e ela recomenda {meta_sugerida}x, projetando {ganho_gmv}% mais faturamento.","passos":["Confira o seu piso pela margem antes de mexer","Se a sugestao estiver abaixo do piso, NAO siga","Descendo, va em degraus de 20% e meca 7 dias"]}',
 'pas/v1/diagnosis/list_verdict',
 'DECIFRADO. 37 capturas. Entrega o alvo com numero. Problemas vistos: low_traffic (31x), room_more_traffic (5x).'),

('shopee_verdict','budget_and_balance_v2',
 '{"eixo":"budget_and_balance_v2","entrega_alvo":null}',
 '{"nivel":"amarelo","titulo":"Orcamento ou saldo limitando","texto":"A Shopee sinalizou este eixo. Nao sabemos ainda qual alvo ela entrega quando ele falha.","passos":["Verificar orcamento diario e saldo da conta"]}',
 'pas/v1/diagnosis/list_verdict',
 'NAO DECIFRADO. 1 captura, veio good e sem campos. Precisa de coleta numa conta com orcamento limitando.'),

('shopee_verdict','continuance_v2',
 '{"eixo":"continuance_v2","entrega_alvo":null}',
 '{"nivel":"amarelo","titulo":"Campanha alterada demais","texto":"A Shopee sinalizou continuidade. Mexer com frequencia reinicia o aprendizado.","passos":["Nao alterar antes do fim do aprendizado: 7 dias em Meta de ROAS, 14 em automatico"]}',
 'pas/v1/diagnosis/list_verdict',
 'NAO DECIFRADO. 1 captura, veio good e sem campos.'),

('shopee_verdict','competitiveness_v2',
 '{"eixo":"competitiveness_v2","entrega_alvo":null}',
 '{"nivel":"amarelo","titulo":"O produto nao compete na categoria","texto":"Este eixo nao se resolve no anuncio. Se ele esta ruim, mexer em meta e jogar dinheiro fora.","passos":["Comparar preco com os primeiros da busca","Rever ficha e prova social antes de investir mais"]}',
 'pas/v1/diagnosis/list_verdict',
 'NAO DECIFRADO. 1 captura, veio good e sem campos. Pista: get_product_performance_info traz competitiveness 0-100.')
on conflict (dominio, chave, versao) do nothing;

-- ============================================================
-- CHECKLIST DE QUALIDADE — como se ganha organico
-- CONFIRMADO em get_smart_diagnosis_info
-- ============================================================
insert into conhecimento (dominio, chave, condicao, veredito, fonte) values
('qualidade_anuncio','checklist',
 '{"tarefas":[
   {"id":25,"chave":"video_include","rotulo":"Tem video no anuncio"},
   {"id":22,"chave":"image_count","rotulo":"Quantidade minima de fotos","minimo":2},
   {"id":17,"chave":"image_not_unfitted","rotulo":"Foto no enquadramento certo"},
   {"id":18,"chave":"image_not_blurry","rotulo":"Foto sem borrao"},
   {"id":19,"chave":"image_clean_background","rotulo":"Fundo limpo na foto principal"},
   {"id":26,"chave":"image_without_prohibited_watermark","rotulo":"Sem marca dagua proibida"},
   {"id":24,"chave":"title_char_count","rotulo":"Titulo com o minimo de caracteres","minimo":10},
   {"id":14,"chave":"title_not_spam","rotulo":"Titulo sem repeticao de palavra-chave"},
   {"id":15,"chave":"title_not_exaggerate","rotulo":"Titulo sem exagero"},
   {"id":16,"chave":"title_includes_product_or_brand_name","rotulo":"Titulo contem nome do produto ou marca"},
   {"id":23,"chave":"desc_char_count_or_image_count","rotulo":"Descricao com 60+ caracteres ou 1+ imagem"}
 ],"janela_produto_novo_dias":90}',
 '{"nivel":"amarelo","titulo":"Faltam {n_faltando} tarefas de qualidade","texto":"A Shopee pontua {n_total} itens neste anuncio e {n_faltando} nao estao cumpridos. Restam {prazo} dias da janela de produto novo.","passos":["Cumprir as tarefas pendentes antes do fim da janela"]}',
 'get_smart_diagnosis_info')
on conflict (dominio, chave, versao) do nothing;

-- ============================================================
-- OS 6 FORMATOS DE ADS — identificados por type e subtype
-- ============================================================
insert into conhecimento (dominio, chave, condicao, veredito, fonte, observacao) values
('ads_formato','gmv_max_meta_roas',
 '{"type":"product_manual","subtype":"product_homepage__roi_two__target","tem_meta":true,"aprendizado_dias":7,"lance_manual":false}',
 '{"rotulo":"GMV Max · Meta de ROAS","permite":["ajustar meta","ajustar orcamento"],"proibe":["falar de palavra-chave","falar de lance"]}',
 'pas/v1/homepage/query', '126 capturas. O teto pratico e 2x o topo recomendado da categoria.'),

('ads_formato','gmv_max_automatico',
 '{"type":"product_manual","subtype":null,"tem_meta":false,"aprendizado_dias":14,"lance_manual":false}',
 '{"rotulo":"GMV Max · Lance Automatico","permite":["ajustar orcamento"],"proibe":["sugerir ajuste de meta - nao existe meta neste formato","falar de palavra-chave"]}',
 'pas/v1/homepage/query', '76 capturas.'),

('ads_formato','gmv_max_roi2_simples',
 '{"type":"product_manual","subtype":"product_homepage__roi_two__simple","tem_meta":true,"aprendizado_dias":7}',
 '{"rotulo":"GMV Max · ROI2 Simples","permite":["ajustar orcamento"],"proibe":["sugerir valor de meta sem confirmar que o campo e editavel"]}',
 'pas/v1/homepage/query', '14 capturas.'),

('ads_formato','grupo_de_anuncios',
 '{"type":"product_mpd","tem_meta":true,"meta_unica":true,"orcamento_unico":true,"aprendizado_dias":14,"metrica_por_produto":false}',
 '{"rotulo":"Grupo de Anuncios","permite":["ajustar meta do grupo","ajustar orcamento do grupo","extrair ou remover produto"],"proibe":["afirmar custo por produto dentro do grupo - o dado nao existe","falar de palavra-chave","sugerir alteracao antes de 14 dias"],"leitura_exclusiva":"comparar broad_roi com direct_roi: distancia grande com GMV total crescendo e descoberta; sem crescer e canibalizacao do organico"}',
 'pas/v1/homepage/query', '11 capturas. mpd.item_list traz os IDs de dentro. Report e agregado.'),

('ads_formato','busca_de_loja',
 '{"type":"shop_manual","lance_manual":true,"lance_minimo":0.17,"passo":0.02}',
 '{"rotulo":"Busca de Loja","permite":["ajustar lance por palavra","escolher correspondencia ampla ou exata"],"proibe":["falar de meta de ROAS por palavra"]}',
 'pas/v1/homepage/query', '11 capturas. Unico formato com lance manual.'),

('ads_formato','anuncio_automatico_loja',
 '{"type":"shop_auto","tem_meta":false,"roi_two_target":0,"orcamento_minimo":15,"perpetuo":true}',
 '{"rotulo":"Anuncio Automatico de Loja","permite":["ajustar orcamento","pausar"],"proibe":["sugerir ajuste de meta - roi_two_target e sempre zero"],"alerta":"ativo por mais de 60 dias sem meta gasta no minimo R$450/mes sem controle de rentabilidade"}',
 'pas/v1/homepage/query', '2 capturas. Criado pela plataforma, absorve produto novo automaticamente.')
on conflict (dominio, chave, versao) do nothing;

-- ============================================================
-- TRAVAS DO ALGORITMO — o que a plataforma aceita
-- CUIDADO: as travas de mudanca sao do modo CPS, nao universais
-- ============================================================
insert into conhecimento (dominio, chave, condicao, veredito, fonte, observacao) values
('algoritmo','travas_cps',
 '{"escopo":"apenas modo CPS","mudanca_meta_pct":20,"mudanca_meta_por_dia":1,"queda_orcamento_pct":20,"bloqueio_dias":7,"teto_multiplicador":7}',
 '{"rotulo":"Travas de alteracao (modo CPS)"}',
 'pas/v1/config/get · ads_config.roi_two.cps',
 'NAO SAO UNIVERSAIS. Campanhas com cps=false nao tem estas travas. Verificar manual_product_ads.cps antes de aplicar.'),

('algoritmo','universais',
 '{"aprendizado_automatico_dias":14,"aprendizado_meta_roas_dias":7,"lance_min_busca_produto":0.11,"lance_min_busca_loja":0.17,"passo_lance":0.02,"meta_min":1,"meta_max":50,"nota_minima_lista_branca":4.0}',
 '{"rotulo":"Regras que valem para todas as contas"}',
 'pas/v1/config/get', 'Confirmado.'),

('algoritmo','teto_meta_dinamico',
 '{"multiplicador_aviso":1.25,"multiplicador_teto":2.0,"base":"upper_bound recomendado da categoria"}',
 '{"rotulo":"Teto pratico da meta de ROAS"}',
 'pas/v1/config/get · roi_two',
 'O teto nao e fixo: e 2x o topo recomendado. upper_bound 10x resulta em teto 20x. Explica por que varia entre contas.'),

('algoritmo','campos_api_enganosos',
 '{"cpc":"e custo por PEDIDO, nao por clique","cpm":"e valor de custo, nao taxa por mil","ctr":"vem como fracao","conversao":"vem como fracao"}',
 '{"rotulo":"Campos que nao podem ser lidos pelo nome"}',
 'medicao propria em 43 campanhas',
 'PROVADO com erro 0,00%. CPC real = gasto/cliques. CPM real = gasto/impressoes*1000.')
on conflict (dominio, chave, versao) do nothing;

-- ============================================================
-- O QUE NAO EXISTE NA SHOPEE — evita recomendacao impossivel
-- ============================================================
insert into conhecimento (dominio, chave, condicao, veredito, fonte) values
('restricao','nao_existe',
 '{"itens":["remarketing (so Transmissao via Chat)","segmentacao de anuncio por idade ou genero","lance manual em anuncio de produto apos o oCPM","metrica por produto dentro de Grupo de Anuncios","meta de ROAS em Lance Automatico ou Anuncio Automatico de Loja"]}',
 '{"rotulo":"Nunca recomendar"}',
 'Metodo Efeito Vendas + medicao propria')
on conflict (dominio, chave, versao) do nothing;

-- ============================================================
-- POSTURA EDITORIAL
-- ============================================================
insert into conhecimento (dominio, chave, condicao, veredito, fonte) values
('postura','linguagem',
 '{"regras":[
   "frase de resultado, nunca metafora: dizer 252 colocaram no carrinho e 21 compraram, nao o carrinho esta vazando",
   "uma frase responde uma pergunta e para",
   "todo numero vem com a unidade de decisao: 109 de posicao vira posicao 109, fundo da vitrine",
   "quando nao sabemos, escrever que nao sabemos",
   "nunca culpar a plataforma: quando a recomendacao dela divergir do interesse do vendedor, nomear a diferenca de objetivo",
   "ordenar por dinheiro em jogo, nunca por gravidade",
   "preco e sempre o ultimo passo, e so se a margem aguentar"
 ]}',
 '{"rotulo":"Como o consultor fala"}',
 'Metodo Efeito Vendas')
on conflict (dominio, chave, versao) do nothing;

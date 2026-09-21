import {
  BarChart,
  Callout,
  ChartComparisonGrid,
  ChartContainer,
  H1,
  LineChart,
  MetricsGrid,
  PieChart,
  ReportSection,
  ReportShell,
  Stack,
  Table,
  Text,
  type MetricItem,
} from "qoder/canvas";

// —— 报告数据契约（由 scripts/lib/breakdown.mjs 产出，plugin 注入）——
interface CatRow {
  key: string;
  label: string;
  tokens: number;
  share: number;
}
interface ToolRow {
  tool: string;
  tokens: number;
  calls: number;
  /** 平均每次调用带来的重发 token；无调用记录时 null（不给 0） */
  perCall?: number | null;
  share: number;
}
interface FileRow {
  attr: string;
  label: string;
  kind: string;
  tool: string | null;
  selfTokens: number;
  reads: number;
  trips: number;
  billed: number;
  /** 单次读取的总代价（含此后每一程重发）；reads=0 时 null */
  perRead?: number | null;
  share: number;
}
interface ReqRow {
  index: number;
  time: string | null;
  ratio: number;
  inputTokens: number;
  /** 代理或转录任一有真值即非 null；两者都没则 null（不写 0） */
  outputTokens?: number | null;
  /** proxy=代理实测 / transcript-tokens=转录 input_tokens / transcript-ratio=转录 ratio×window */
  usageSource?: "proxy" | "transcript-tokens" | "transcript-ratio" | "transcript";
  credits: number;
  originalCredits: number;
  afterCompact: boolean;
}
interface CatChild {
  tool: string | null;
  label: string;
  kind: string | null;
  tokens: number;
  share: number;
  catShare: number;
  trips: number;
}
interface CatDetail {
  key: string;
  label: string;
  tokens: number;
  share: number;
  children: CatChild[];
}
interface SubagentRow {
  agentId: string;
  agentType: string | null;
  description: string | null;
  toolUseId: string | null;
  roundTrips: number;
  billedInputTokens: number;
  peakContextRatio: number;
  credits: number;
  originalCredits: number;
  error: string | null;
}
interface SubagentTotals {
  roundTrips: number;
  billedInputTokens: number;
  credits: number;
  originalCredits: number;
}
interface Subagents {
  scanned: boolean;
  dir: string | null;
  /** 试过的候选目录；用于区分「真没子代理」与「路径没找对」。 */
  probedPaths?: string[];
  /** ok=已汇总 / no-dir=无子代理目录 / dir-empty=目录在但无 agent 文件 / no-usage=有文件但转录无 usage / error=读取抛错 */
  reason?: string;
  count: number;
  items: SubagentRow[];
  totals: SubagentTotals;
  combined: SubagentTotals;
}
/** 逐项可用性：报告里每个数字到底是模型上报的真值、按真值推导、回退默认、手工录入，还是本地根本没有。
 *  v2 旧报告没这个对象，故全部字段可选，读取时一律走默认值（旧报告只可能来自桌面端富转录）。 */
type Avail = "measured" | "derived" | "fallback" | "manual" | "unavailable";
interface Availability {
  credits?: Avail;
  roundTrips?: Avail;
  contextRatio?: Avail;
  tokens?: Avail;
  /** 输出 token：代理或转录 output_tokens 任一有真值即 measured */
  outputTokens?: Avail;
  /** 缓存命中 token：代理或转录 cache_read_input_tokens 任一有真值即 measured */
  cachedTokens?: Avail;
  categoryShare?: Avail;
  toolShare?: Avail;
  fileShare?: Avail;
  systemPrompt?: Avail;
  contextWindow?: Avail;
  compactions?: Avail;
  compactionCost?: Avail;
  model?: Avail;
  title?: Avail;
  toolCalls?: Avail;
  fileReads?: Avail;
  userTurns?: Avail;
  /** 用户压缩阈值：manual 覆盖 → manual；默认 200K → fallback */
  userContextLimit?: Avail;
}
/** 官方 UI 真值（手工录入，来自 .qoder-credits/overrides/<sessionId>.json）。
 *  IDE 端转录不含 usage，本地算不出 Credits，这是唯一的真值通道；绝不覆盖 totals，只并列展示。 */
interface ManualTruth {
  file?: string;
  credits: number | null;
  originalCredits: number | null;
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMin: number | null;
  note: string | null;
  /** 手工锁定模型窗口（如 qwen3-max=1000000），优先于 runtime-config / 反推 / fallback */
  contextWindow?: number | null;
  /** 手工指定 Qoder 压缩触发阈值（默认 200000），驱动 peakUserAdvice */
  userContextLimit?: number | null;
  /** 本地 credits ÷ 官方真值。有子代理时拿 combined 比（官方 UI 扣费 = 主链 + 子代理），
   *  否则覆盖率会被系统性低估（实测 ca2f7834：主链比 0.46、combined 比 0.89）。 */
  localCoverage?: number | null;
  /** main=只比主链 / combined=比主链+子代理 */
  localScope?: "main" | "combined";
  /** 参与对账的本地 credits（按 localScope 取 totals.credits 或 subagents.combined.credits） */
  localCredits?: number | null;
}
/** 峰值占比的「该不该压」结论。阈值算在数据层（breakdown.mjs peakAdvice），
 *  这里只管展示——否则 Canvas 与终端各持一套阈值迟早走偏。tone 直接喂 Callout。 */
interface PeakAdvice {
  level: "low" | "mid" | "sweet" | "high" | "over";
  tone: "info" | "success" | "warning" | "danger";
  text: string;
}
/** 一次压缩 = 一笔普通模型调用（整份上下文当 prompt、摘要当 completion），是会话里单笔最贵的开销。
 *  pre/post 是客户端自估口径；proxy 是能在代理日志里唯一对上时回填的供应商实测值，对不上就 null。 */
interface CompactionEvent {
  index: number;
  at: string | null;
  trigger: string | null;
  preTokens: number | null;
  postTokens: number | null;
  messagesSummarized: number | null;
  /** 压缩后首轮的往返序号与实测输入 = 压缩把上下文压到的地板 */
  nextRequestIndex: number | null;
  nextInputTokens: number | null;
  savedTokens: number | null;
  /** 数据层归一后的生效值：有代理实测就用实测，否则是客户端自估。
   *  渲染端直接取这两个，别自己按 proxy 分支——否则会与合计的口径分叉。 */
  effectiveInputTokens?: number | null;
  effectiveOutputTokens?: number | null;
  proxy?: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number | null;
    ms: number | null;
    matchedBy: string;
  } | null;
}
interface CompactionCost {
  count: number;
  items: CompactionEvent[];
  /** measured = items 里有几笔拿到了供应商实测（其余为客户端自估） */
  totals: { preTokens: number; postTokens: number; savedTokens: number; measured?: number };
}
/** 链路健康度：代理覆盖率 + 最近记录时间 + 最近若干笔的三方归因计数。
 *  逐笔明细属于排障（CLI --request-log），报告只给一行结论。 */
interface LinkHealth {
  matched: number;
  requests: number;
  coverage: number;
  /** proxy / transcript-tokens / transcript-ratio / mixed / transcript（v3 旧报告）/ null */
  usageSource?: "proxy" | "transcript-tokens" | "transcript-ratio" | "mixed" | "transcript" | null;
  /** 三档拆分：代理实测 / 转录 input_tokens / 转录 ratio×window */
  breakdown?: { proxy: number; transcriptTokens: number; transcriptRatio: number };
  logRecords?: number;
  lastRecordAt?: string | null;
  /** 参与归因的最近笔数；0 = 运行中的代理是旧版或还没记到诊断 */
  recentRequests?: number;
  proxyErrors?: number | null;
  upstreamRejected?: number | null;
  aborted?: number | null;
  truncated?: number | null;
  noUsage?: number | null;
  slowestMs?: number | null;
  /** 被更新流量推翻的那条陈旧拉起失败记录；null = 没有 */
  supersededFailure?: { error: string; port?: number; at?: string | null } | null;
}
interface Report {
  schemaVersion: number;
  generatedAt: string;
  pluginVersion?: string;
  /** 转录来自哪一代客户端：桌面端富转录有 usage 真值，IDE 端精简转录没有。v2 旧报告无此字段。 */
  source?: "desktop-rich" | "ide-lite" | "unknown";
  /** usage 数字的来源：proxy=代理实测 / transcript-tokens=转录 input_tokens 真值 /
   *  transcript-ratio=转录 ratio×window 推导 / mixed=多档混合 / transcript=v3 旧报告兼容。无 usage 时 null。 */
  usageSource?: "proxy" | "transcript-tokens" | "transcript-ratio" | "mixed" | "transcript" | null;
  /** 可直接粘贴执行的插件入口命令（generate.mjs 用 proxy.mjs 的 selfCmd() 注入）。
   *  Windows 上是插件自带启动器的绝对路径，不要求用户装 Node；模板是静态文本，拿不到就只能硬编码。 */
  selfCmd?: string | null;
  /** 链路健康度一行结论（逐笔明细留给 CLI --request-log） */
  linkHealth?: LinkHealth | null;
  /** 代理 join 诊断（lib/proxylog.mjs）+ 配置/状态（generate.mjs 注入） */
  proxy?: {
    matched: number;
    requests: number;
    /** 三档拆分：代理实测 / 转录 input_tokens / 转录 ratio×window */
    breakdown?: { proxy: number; transcriptTokens: number; transcriptRatio: number };
    logPath?: string;
    logExists?: boolean;
    logRecords?: number;
    /** config.json 里 upstream 合法 = 用户已配置代理 */
    configured?: boolean;
    enabled?: boolean;
    port?: number;
    /** 最近一条代理记录的时间；null = 从无流量 */
    lastRecordAt?: string | null;
    /** 已配置但长期零流量（多半已改回官方模型）——软提示可 --stop-proxy */
    dormant?: boolean;
    /** 最近一次自动拉起失败（如端口被占）；ok 时为 null */
    status?: { error: string; port?: number; at?: string | null } | null;
    /** status 那条失败记录是否已被更新的流量推翻（代理在它之后还记到了流量）。
     *  status.json 只写不清，陈旧失败会把用户推去改本来正确的 Base URL，故必须判掉。 */
    statusSuperseded?: boolean;
  };
  availability?: Availability;
  manual?: ManualTruth | null;
  session: {
    id: string | null;
    title: string | null;
    /** custom-title / first-user / session-id —— 令产物文件名可解释 */
    titleSource?: string;
    model: string | null;
    /** runtime-config / manual / unavailable */
    modelSource?: string;
    cwd: string | null;
    turns: number;
    roundTrips: number;
    compactions: number;
    startedAt: string | null;
    endedAt: string | null;
  };
  context: {
    contextWindow: number;
    /** runtime-config=实测 / derived-from-usage=从 usage 反推 / manual=ManualTruth 手工锁定 /
     *  fallback=读不到静默回退 200000 / caller=调用方传入（旧枚举，兼容）。
     *  报告里每个 token 数字都要乘它，回退时必须标出来。 */
    contextWindowSource?: string;
    systemPromptTokens: number;
    netContextTokens: number;
    /** 峰值 = 当前窗口口径：自最近一次压缩起算，压缩边界处归零重新累积 */
    peakContextTokens: number;
    peakContextRatio: number;
    /** 本场历史峰值（跨压缩）；整场没压缩过时与上面相等 */
    peakSessionTokens?: number;
    peakSessionRatio?: number;
    /** 历史峰值是否值得单独交代（与当前窗口峰值相差 ≥1 个百分点），渲染端直接取用不再自判 */
    peakSessionNotable?: boolean;
    /** 峰值占比的「该不该压」结论（对模型窗口）；无有效占比时 null */
    peakAdvice?: PeakAdvice | null;
    /** 用户压缩阈值（Qoder 自动触发点），与模型窗口独立。默认 200000，ManualTruth 可覆盖 */
    userContextLimit?: number;
    /** default=内置 200K / manual=overrides 手写 / config=插件配置 / derived=实测反推 */
    userContextLimitSource?: "default" | "manual" | "config" | "derived";
    /** peakContextTokens ÷ userContextLimit */
    peakUserRatio?: number;
    /** 对用户阈值的「快自动压缩了吗」结论；与 peakAdvice 可矛盾（模型窗口未满但用户阈值已超） */
    peakUserAdvice?: PeakAdvice | null;
    /** v3.2 当前占用头条口径：段内单调递增 ⇒ 峰值≡当前，故以 netContextTokens 作头条，peak 退灰字 */
    currentContextTokens?: number;
    netUserRatio?: number;
    netUserAdvice?: PeakAdvice | null;
    netWindowRatio?: number;
    /** v3.2 自动压缩自校准：本场 trigger=auto 的实际触发点（无需外部配置）与「阈值是否被强制」判定 */
    observedAutoCompactions?: number;
    observedAutoTriggerTokens?: number | null;
    autoTriggerRatio?: number | null;
    thresholdNotEnforced?: boolean;
  };
  totals: {
    billedInputTokens: number;
    netContextTokens: number;
    peakContextTokens: number;
    amplification: number;
    attributedTokens: number;
    coverage: number;
    credits: number;
    originalCredits: number;
    /** 输出 token 总量：仅代理路径有真值，否则 0 且 availability.outputTokens=unavailable */
    outputTokens?: number;
    /** 供应商上下文缓存命中的那部分 prompt：仅代理路径有真值 */
    cachedTokens?: number;
    cachedTrips?: number;
    /** 缓存命中 ÷ 计费输入总量（全局实测约 91.5%：重复叠加的前缀正是缓存的命中对象） */
    cachedShare?: number;
    /** 两个不依赖 usage 的计数，IDE 端占比全缺时仍有可展示的真值 */
    toolCalls?: number;
    fileReads?: number;
  };
  /** credits 的分子到底覆盖了多少：与计费输入总量并排展示时，部分覆盖不说就等于把局部真值当全量。 */
  creditsCoverage?: {
    /** 真正累加进 totals.credits 的往返数 */
    trips: number;
    roundTrips: number;
    /** 这些往返的计费输入之和 */
    tokens: number;
    tokenShare: number;
    /** trips === roundTrips：全覆盖时不必再啰嗦覆盖范围 */
    full: boolean;
  };
  /** 压缩单笔成本（此前只显示「压缩 N 次」，而它是会话里单笔最贵的调用） */
  compactionCost?: CompactionCost;
  byCategory: CatRow[];
  byCategoryDetail: CatDetail[];
  byTool: ToolRow[];
  byFile: FileRow[];
  byRequest: ReqRow[];
  subagents?: Subagents;
  identity: { sumAttributed: number; billedInputTokens: number; absDiff: number; ok: boolean | null };
}

// 注入点：下一行的 REPORT 初值会被 render-canvas.mjs 按整行替换为真实报告 JSON。
const REPORT = {"schemaVersion":3.2,"generatedAt":"2026-09-21T07:55:25.516Z","source":"desktop-rich","usageSource":"transcript-ratio","availability":{"credits":"measured","roundTrips":"measured","contextRatio":"measured","tokens":"derived","outputTokens":"unavailable","cachedTokens":"unavailable","categoryShare":"derived","toolShare":"derived","fileShare":"derived","systemPrompt":"derived","contextWindow":"measured","compactions":"measured","compactionCost":"measured","model":"measured","title":"measured","toolCalls":"measured","fileReads":"measured","userTurns":"measured","userContextLimit":"fallback"},"session":{"id":"c4c64b31-83f6-409f-89bf-cd9bcc89f6e0","title":"使用产品设计的相关技能，梳理当前项目，构建项目架","titleSource":"first-user","model":"auto","modelSource":"runtime-config","cwd":"D:\\UGit\\multdc","turns":10,"roundTrips":109,"compactions":4,"startedAt":"2026-09-21T03:47:23.898Z","endedAt":"2026-09-21T07:55:24.764Z"},"context":{"contextWindow":128000,"contextWindowSource":"runtime-config","systemPromptTokens":19256,"netContextTokens":92356,"peakContextTokens":92356,"peakContextRatio":0.72153125,"peakSessionTokens":92356,"peakSessionRatio":0.72153125,"peakSessionNotable":false,"peakAdvice":{"level":"sweet","tone":"success","text":"正处性价比区间（65–85%）。此时压一次每轮省得最多，且第一轮就回本"},"userContextLimit":200000,"userContextLimitSource":"default","peakUserRatio":0.46178,"peakUserAdvice":{"level":"mid","tone":"info","text":"已过盈亏线（39%）但还没进性价比区间，压缩有净收益但不大；不急着压"},"currentContextTokens":92356,"netUserRatio":0.46178,"netUserAdvice":{"level":"mid","tone":"info","text":"已过盈亏线（39%）但还没进性价比区间，压缩有净收益但不大；不急着压"},"netWindowRatio":0.72153125,"observedAutoCompactions":4,"observedAutoTriggerTokens":109877,"autoTriggerRatio":0.8584140625,"thresholdNotEnforced":false},"totals":{"billedInputTokens":7713723,"netContextTokens":92356,"peakContextTokens":92356,"amplification":83.52,"attributedTokens":7713723,"coverage":1,"credits":71.405,"originalCredits":71.405,"outputTokens":0,"cachedTokens":0,"cachedTrips":0,"cachedShare":0,"toolCalls":123,"fileReads":67},"creditsCoverage":{"trips":109,"roundTrips":109,"tokens":7713723,"tokenShare":1,"full":true},"compactionCost":{"count":4,"items":[{"index":1,"at":"2026-09-21T03:48:24.689Z","trigger":"auto","preTokens":109877,"postTokens":1986,"messagesSummarized":38,"nextRequestIndex":6,"nextInputTokens":73482,"savedTokens":36395,"proxy":null,"effectiveInputTokens":109877,"effectiveOutputTokens":1986},{"index":2,"at":"2026-09-21T04:01:03.553Z","trigger":"auto","preTokens":97249,"postTokens":2509,"messagesSummarized":35,"nextRequestIndex":15,"nextInputTokens":47974,"savedTokens":49275,"proxy":null,"effectiveInputTokens":97249,"effectiveOutputTokens":2509},{"index":3,"at":"2026-09-21T06:23:51.155Z","trigger":"auto","preTokens":113074,"postTokens":3136,"messagesSummarized":114,"nextRequestIndex":41,"nextInputTokens":48629,"savedTokens":64445,"proxy":null,"effectiveInputTokens":113074,"effectiveOutputTokens":3136},{"index":4,"at":"2026-09-21T07:34:04.264Z","trigger":"auto","preTokens":105972,"postTokens":3238,"messagesSummarized":119,"nextRequestIndex":76,"nextInputTokens":48693,"savedTokens":57279,"proxy":null,"effectiveInputTokens":105972,"effectiveOutputTokens":3238}],"totals":{"preTokens":426172,"postTokens":10869,"savedTokens":207394,"measured":0}},"proxy":{"matched":0,"requests":109,"breakdown":{"proxy":0,"transcriptTokens":0,"transcriptRatio":109},"logPath":"C:\\Users\\29670\\.qoder-credits-proxy\\usage.jsonl","logExists":false,"logRecords":0,"configured":false,"enabled":true,"port":49787,"lastRecordAt":null,"dormant":false,"status":null,"statusSuperseded":false},"byCategory":[{"key":"tool_result","label":"工具返回","tokens":700512,"share":0.09081367226211692},{"key":"system","label":"系统提示词","tokens":2098904,"share":0.27209999633121384},{"key":"compact_summary","label":"压缩摘要","tokens":265129,"share":0.03437110259103814},{"key":"assistant_thinking","label":"模型思考","tokens":166147,"share":0.021539166918503078},{"key":"assistant_tool_use","label":"工具调用","tokens":1108587,"share":0.143716208447978},{"key":"assistant_text","label":"模型回复","tokens":15210,"share":0.0019718450562796717},{"key":"user_input","label":"用户输入","tokens":302954,"share":0.03927468149656381},{"key":"attachment","label":"附件/技能","tokens":3056280,"share":0.3962133268963074}],"byCategoryDetail":[{"key":"tool_result","label":"工具返回","tokens":700512,"share":0.09081367226211692,"children":[{"tool":"Read","label":"项目架构雏形与冲突分析.md","kind":"read","tokens":633553,"share":0.08213326319519557,"catShare":0.9044151739413537,"trips":62},{"tool":"Edit","label":"项目架构雏形与冲突分析.md","kind":"write","tokens":31978,"share":0.00414562872233976,"catShare":0.04564983024113558,"trips":767},{"tool":"Bash","label":"（无路径）","kind":"shell","tokens":14197,"share":0.0018405146179846957,"catShare":0.02026693307448673,"trips":244},{"tool":"Agent","label":"（无路径）","kind":"other","tokens":11548,"share":0.0014970654258785897,"catShare":0.016485022448575654,"trips":78},{"tool":"TaskCreate","label":"（无路径）","kind":"other","tokens":4078,"share":0.0005286896279380794,"catShare":0.005821696389637391,"trips":202},{"tool":"TaskUpdate","label":"（无路径）","kind":"other","tokens":1259,"share":0.0001631824976348621,"catShare":0.001796893502598,"trips":243},{"tool":"TaskList","label":"（无路径）","kind":"other","tokens":1038,"share":0.00013460751854162164,"catShare":0.0014822384690391316,"trips":24},{"tool":"Glob","label":"design","kind":"search","tokens":633,"share":0.00008202704522180158,"catShare":0.0009032455485892658,"trips":21},{"tool":"Write","label":"design/cross-plane/zone-manifest-protocol.md","kind":"write","tokens":473,"share":0.00006135656963949988,"catShare":0.0006756314122217793,"trips":25},{"tool":"Write","label":"design/cross-plane/degradation-autonomy.md","kind":"write","tokens":454,"share":0.000058896688632687345,"catShare":0.0006485442903651436,"trips":24},{"tool":"Write","label":"design/cross-plane/decisions-log.md","kind":"write","tokens":396,"share":0.00005131690680622243,"catShare":0.0005650790847671664,"trips":23},{"tool":"Write","label":"design/README.md","kind":"write","tokens":374,"share":0.0000484694819163521,"catShare":0.0005337245010470877,"trips":29},{"tool":"Glob","label":"D:/UGit/multdc","kind":"search","tokens":343,"share":0.00004443923085338705,"catShare":0.0004893451585695313,"trips":6},{"tool":"Write","label":"项目架构雏形与冲突分析.md","kind":"write","tokens":111,"share":0.000014379703079788957,"catShare":0.00015834293142870157,"trips":5},{"tool":"Skill","label":"（无路径）","kind":"other","tokens":76,"share":0.000009835030453320197,"catShare":0.00010829900617754115,"trips":8}]},{"key":"system","label":"系统提示词","tokens":2098904,"share":0.27209999633121384,"children":[]},{"key":"compact_summary","label":"压缩摘要","tokens":265129,"share":0.03437110259103814,"children":[]},{"key":"assistant_thinking","label":"模型思考","tokens":166147,"share":0.021539166918503078,"children":[]},{"key":"assistant_tool_use","label":"工具调用","tokens":1108587,"share":0.143716208447978,"children":[{"tool":"Edit","label":"项目架构雏形与冲突分析.md","kind":"write","tokens":406529,"share":0.05270208913437818,"catShare":0.36670943175804105,"trips":767},{"tool":"Agent","label":"（无路径）","kind":"other","tokens":252444,"share":0.032726546519206375,"catShare":0.22771646199567422,"trips":78},{"tool":"Write","label":"design/cross-plane/degradation-autonomy.md","kind":"write","tokens":104038,"share":0.013487341696885403,"catShare":0.09384704649905591,"trips":24},{"tool":"Write","label":"design/README.md","kind":"write","tokens":98729,"share":0.012799174524711378,"catShare":0.0890586709942629,"trips":29},{"tool":"Write","label":"design/cross-plane/zone-manifest-protocol.md","kind":"write","tokens":92140,"share":0.011945008534817178,"catShare":0.08311524958676461,"trips":25},{"tool":"Write","label":"design/cross-plane/decisions-log.md","kind":"write","tokens":88887,"share":0.01152321142333725,"catShare":0.08018031889220338,"trips":23},{"tool":"Write","label":"项目架构雏形与冲突分析.md","kind":"write","tokens":37816,"share":0.004902372619201897,"catShare":0.03411148034131755,"trips":5},{"tool":"TaskCreate","label":"（无路径）","kind":"other","tokens":13372,"share":0.0017335862622020874,"catShare":0.012062566087175939,"trips":202},{"tool":"Bash","label":"（无路径）","kind":"shell","tokens":11018,"share":0.001428309812077218,"catShare":0.009938404495232936,"trips":244},{"tool":"TaskUpdate","label":"（无路径）","kind":"other","tokens":1888,"share":0.0002447737464522932,"catShare":0.0017031742563741218,"trips":243},{"tool":"Read","label":"项目架构雏形与冲突分析.md","kind":"read","tokens":1326,"share":0.0001718599922044195,"catShare":0.0011958288773435664,"trips":62},{"tool":"Glob","label":"design","kind":"search","tokens":253,"share":0.00003281081808872064,"catShare":0.00022830283684110279,"trips":21},{"tool":"Skill","label":"（无路径）","kind":"other","tokens":64,"share":0.000008359775885322168,"catShare":0.00005816863647880202,"trips":8},{"tool":"Glob","label":"D:/UGit/multdc","kind":"search","tokens":61,"share":0.00000795926522747231,"catShare":0.000055381820279188504,"trips":6},{"tool":"TaskList","label":"（无路径）","kind":"other","tokens":22,"share":0.0000028043233029504506,"catShare":0.000019512922955837315,"trips":24}]},{"key":"assistant_text","label":"模型回复","tokens":15210,"share":0.0019718450562796717,"children":[]},{"key":"user_input","label":"用户输入","tokens":302954,"share":0.03927468149656381,"children":[]},{"key":"attachment","label":"附件/技能","tokens":3056280,"share":0.3962133268963074,"children":[]}],"byTool":[{"tool":"Read","tokens":634879,"calls":9,"perCall":70542,"share":0.0823051231874},{"tool":"Edit","tokens":438508,"calls":51,"perCall":8598,"share":0.05684771785671768},{"tool":"Write","tokens":423418,"calls":5,"perCall":84684,"share":0.054891528149027674},{"tool":"Agent","tokens":263991,"calls":3,"perCall":87997,"share":0.03422361194508497},{"tool":"Bash","tokens":25215,"calls":23,"perCall":1096,"share":0.003268824430061917},{"tool":"TaskCreate","tokens":17451,"calls":9,"perCall":1939,"share":0.0022622758901401667},{"tool":"TaskUpdate","tokens":3147,"calls":18,"perCall":175,"share":0.0004079562440871539},{"tool":"Glob","tokens":1290,"calls":2,"perCall":645,"share":0.00016723635939138161},{"tool":"TaskList","tokens":1060,"calls":1,"perCall":1060,"share":0.00013741184184457207},{"tool":"Skill","tokens":140,"calls":2,"perCall":70,"share":0.000018194806338642367}],"byFile":[{"attr":"file:D:\\UGit\\multdc\\项目架构雏形与冲突分析.md","label":"项目架构雏形与冲突分析.md","kind":"write","tool":"Write","selfTokens":85748,"reads":56,"trips":1668,"billed":1111313,"perRead":19845,"share":0.1440695933663996},{"attr":"file:D:\\UGit\\multdc\\design\\cross-plane\\degradation-autonomy.md","label":"design/cross-plane/degradation-autonomy.md","kind":"write","tool":"Write","selfTokens":5060,"reads":1,"trips":48,"billed":104492,"perRead":104492,"share":0.013546238385518088},{"attr":"file:D:\\UGit\\multdc\\design\\README.md","label":"design/README.md","kind":"write","tool":"Write","selfTokens":3976,"reads":1,"trips":58,"billed":99103,"perRead":99103,"share":0.01284764400662773},{"attr":"file:D:\\UGit\\multdc\\design\\cross-plane\\zone-manifest-protocol.md","label":"design/cross-plane/zone-manifest-protocol.md","kind":"write","tool":"Write","selfTokens":4305,"reads":1,"trips":50,"billed":92614,"perRead":92614,"share":0.01200636510445668},{"attr":"file:D:\\UGit\\multdc\\design\\cross-plane\\decisions-log.md","label":"design/cross-plane/decisions-log.md","kind":"write","tool":"Write","selfTokens":4511,"reads":1,"trips":46,"billed":89283,"perRead":89283,"share":0.011574528330143469},{"attr":"file:D:\\UGit\\multdc\\design","label":"design","kind":"search","tool":"Glob","selfTokens":49,"reads":1,"trips":42,"billed":886,"perRead":886,"share":0.00011483786331052218},{"attr":"file:D:\\UGit\\multdc","label":"D:/UGit/multdc","kind":"search","tool":"Glob","selfTokens":79,"reads":1,"trips":12,"billed":404,"perRead":404,"share":0.00005239849608085937},{"attr":"file:D:/UGit/multdc/需求梳理v3-存储与采集架构.md","label":"需求梳理v3-存储与采集架构.md","kind":"read","tool":"Read","selfTokens":11334,"reads":1,"trips":0,"billed":0,"perRead":0,"share":0},{"attr":"file:D:/UGit/multdc/多网区Prometheus采集与调度架构设计.md","label":"多网区Prometheus采集与调度架构设计.md","kind":"read","tool":"Read","selfTokens":32240,"reads":1,"trips":0,"billed":0,"perRead":0,"share":0},{"attr":"file:D:/UGit/multdc/分区规模接入方案.md","label":"分区规模接入方案.md","kind":"read","tool":"Read","selfTokens":5162,"reads":1,"trips":0,"billed":0,"perRead":0,"share":0},{"attr":"file:D:/UGit/multdc/需求整理与Plan-v2.md","label":"需求整理与Plan-v2.md","kind":"read","tool":"Read","selfTokens":5536,"reads":1,"trips":0,"billed":0,"perRead":0,"share":0},{"attr":"file:D:/UGit/multdc/需求审视与实施Plan.md","label":"需求审视与实施Plan.md","kind":"read","tool":"Read","selfTokens":6651,"reads":1,"trips":0,"billed":0,"perRead":0,"share":0}],"byAttr":[{"attr":"attachment","tokens":3056280,"share":0.3962133268963074},{"attr":"system","tokens":2098904,"share":0.27209999633121384},{"attr":"tool_result|Read","tokens":633553,"share":0.08213326319519557},{"attr":"tool_use|Write","tokens":421610,"share":0.05465710879895311},{"attr":"tool_use|Edit","tokens":406529,"share":0.05270208913437818},{"attr":"user_input","tokens":302954,"share":0.03927468149656381},{"attr":"compact_summary","tokens":265129,"share":0.03437110259103814},{"attr":"tool_use|Agent","tokens":252444,"share":0.032726546519206375},{"attr":"assistant_thinking","tokens":166147,"share":0.021539166918503078},{"attr":"tool_result|Edit","tokens":31978,"share":0.00414562872233976},{"attr":"assistant_text","tokens":15210,"share":0.0019718450562796717},{"attr":"tool_result|Bash","tokens":14197,"share":0.0018405146179846957},{"attr":"tool_use|TaskCreate","tokens":13372,"share":0.0017335862622020874},{"attr":"tool_result|Agent","tokens":11548,"share":0.0014970654258785897},{"attr":"tool_use|Bash","tokens":11018,"share":0.001428309812077218},{"attr":"tool_result|TaskCreate","tokens":4078,"share":0.0005286896279380794},{"attr":"tool_use|TaskUpdate","tokens":1888,"share":0.0002447737464522932},{"attr":"tool_result|Write","tokens":1808,"share":0.00023441935007455073},{"attr":"tool_use|Read","tokens":1326,"share":0.0001718599922044195},{"attr":"tool_result|TaskUpdate","tokens":1259,"share":0.0001631824976348621},{"attr":"tool_result|TaskList","tokens":1038,"share":0.00013460751854162164},{"attr":"tool_result|Glob","tokens":976,"share":0.0001264662760751886},{"attr":"tool_use|Glob","tokens":314,"share":0.00004077008331619295},{"attr":"tool_result|Skill","tokens":76,"share":0.000009835030453320197},{"attr":"tool_use|Skill","tokens":64,"share":0.000008359775885322168},{"attr":"tool_use|TaskList","tokens":22,"share":0.0000028043233029504506}],"byRequest":[{"index":1,"time":"11:47","ratio":0.237016,"inputTokens":30338,"outputTokens":null,"usageSource":"transcript-ratio","credits":1.708,"originalCredits":1.708,"afterCompact":false},{"index":2,"time":"11:47","ratio":0.312805,"inputTokens":40039,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.705,"originalCredits":0.705,"afterCompact":false},{"index":3,"time":"11:47","ratio":0.314359,"inputTokens":40238,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.198,"originalCredits":0.198,"afterCompact":false},{"index":4,"time":"11:47","ratio":0.314906,"inputTokens":40308,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.226,"originalCredits":0.226,"afterCompact":false},{"index":5,"time":"11:47","ratio":0.320469,"inputTokens":41020,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.263,"originalCredits":0.263,"afterCompact":false},{"index":6,"time":"11:48","ratio":0.574078,"inputTokens":73482,"outputTokens":null,"usageSource":"transcript-ratio","credits":3.087,"originalCredits":3.087,"afterCompact":true},{"index":7,"time":"11:48","ratio":0.576508,"inputTokens":73793,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.357,"originalCredits":0.357,"afterCompact":false},{"index":8,"time":"11:48","ratio":0.57725,"inputTokens":73888,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.351,"originalCredits":0.351,"afterCompact":false},{"index":9,"time":"11:49","ratio":0.578484,"inputTokens":74046,"outputTokens":null,"usageSource":"transcript-ratio","credits":1.68,"originalCredits":1.68,"afterCompact":false},{"index":10,"time":"11:50","ratio":0.637781,"inputTokens":81636,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.762,"originalCredits":0.762,"afterCompact":false},{"index":11,"time":"11:50","ratio":0.638437,"inputTokens":81720,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.459,"originalCredits":0.459,"afterCompact":false},{"index":12,"time":"12:00","ratio":0.658344,"inputTokens":84268,"outputTokens":null,"usageSource":"transcript-ratio","credits":4.782,"originalCredits":4.782,"afterCompact":false},{"index":13,"time":"12:00","ratio":0.663008,"inputTokens":84865,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.417,"originalCredits":0.417,"afterCompact":false},{"index":14,"time":"12:00","ratio":0.663594,"inputTokens":84940,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.392,"originalCredits":0.392,"afterCompact":false},{"index":15,"time":"12:01","ratio":0.374797,"inputTokens":47974,"outputTokens":null,"usageSource":"transcript-ratio","credits":1.634,"originalCredits":1.634,"afterCompact":true},{"index":16,"time":"12:01","ratio":0.445789,"inputTokens":57061,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.801,"originalCredits":0.801,"afterCompact":false},{"index":17,"time":"12:01","ratio":0.449836,"inputTokens":57579,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.336,"originalCredits":0.336,"afterCompact":false},{"index":18,"time":"12:01","ratio":0.452594,"inputTokens":57932,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.677,"originalCredits":0.677,"afterCompact":false},{"index":19,"time":"12:01","ratio":0.470664,"inputTokens":60245,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.548,"originalCredits":0.548,"afterCompact":false},{"index":20,"time":"12:01","ratio":0.478203,"inputTokens":61210,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.351,"originalCredits":0.351,"afterCompact":false},{"index":21,"time":"12:02","ratio":0.481086,"inputTokens":61579,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.432,"originalCredits":0.432,"afterCompact":false},{"index":22,"time":"12:02","ratio":0.487633,"inputTokens":62417,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.431,"originalCredits":0.431,"afterCompact":false},{"index":23,"time":"12:02","ratio":0.492914,"inputTokens":63093,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.348,"originalCredits":0.348,"afterCompact":false},{"index":24,"time":"12:02","ratio":0.494781,"inputTokens":63332,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.352,"originalCredits":0.352,"afterCompact":false},{"index":25,"time":"12:02","ratio":0.497766,"inputTokens":63714,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.347,"originalCredits":0.347,"afterCompact":false},{"index":26,"time":"12:03","ratio":0.500133,"inputTokens":64017,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.734,"originalCredits":0.734,"afterCompact":false},{"index":27,"time":"12:03","ratio":0.520781,"inputTokens":66660,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.56,"originalCredits":0.56,"afterCompact":false},{"index":28,"time":"12:03","ratio":0.526875,"inputTokens":67440,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.377,"originalCredits":0.377,"afterCompact":false},{"index":29,"time":"12:03","ratio":0.528937,"inputTokens":67704,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.344,"originalCredits":0.344,"afterCompact":false},{"index":30,"time":"12:03","ratio":0.53068,"inputTokens":67927,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.38,"originalCredits":0.38,"afterCompact":false},{"index":31,"time":"12:03","ratio":0.534023,"inputTokens":68355,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.357,"originalCredits":0.357,"afterCompact":false},{"index":32,"time":"12:03","ratio":0.535828,"inputTokens":68586,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.494,"originalCredits":0.494,"afterCompact":false},{"index":33,"time":"12:03","ratio":0.545203,"inputTokens":69786,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.428,"originalCredits":0.428,"afterCompact":false},{"index":34,"time":"12:03","ratio":0.548117,"inputTokens":70159,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.449,"originalCredits":0.449,"afterCompact":false},{"index":35,"time":"12:04","ratio":0.55375,"inputTokens":70880,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.448,"originalCredits":0.448,"afterCompact":false},{"index":36,"time":"12:04","ratio":0.558398,"inputTokens":71475,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.374,"originalCredits":0.374,"afterCompact":false},{"index":37,"time":"12:04","ratio":0.559945,"inputTokens":71673,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.34,"originalCredits":0.34,"afterCompact":false},{"index":38,"time":"12:04","ratio":0.658727,"inputTokens":84317,"outputTokens":null,"usageSource":"transcript-ratio","credits":1.08,"originalCredits":1.08,"afterCompact":false},{"index":39,"time":"12:04","ratio":0.661758,"inputTokens":84705,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.413,"originalCredits":0.413,"afterCompact":false},{"index":40,"time":"12:04","ratio":0.662711,"inputTokens":84827,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.442,"originalCredits":0.442,"afterCompact":false},{"index":41,"time":"14:23","ratio":0.379914,"inputTokens":48629,"outputTokens":null,"usageSource":"transcript-ratio","credits":1.671,"originalCredits":1.671,"afterCompact":true},{"index":42,"time":"14:24","ratio":0.477687,"inputTokens":61144,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.996,"originalCredits":0.996,"afterCompact":false},{"index":43,"time":"14:24","ratio":0.481641,"inputTokens":61650,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.314,"originalCredits":0.314,"afterCompact":false},{"index":44,"time":"14:24","ratio":0.48243,"inputTokens":61751,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.397,"originalCredits":0.397,"afterCompact":false},{"index":45,"time":"14:24","ratio":0.488008,"inputTokens":62465,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.343,"originalCredits":0.343,"afterCompact":false},{"index":46,"time":"14:24","ratio":0.489695,"inputTokens":62681,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.31,"originalCredits":0.31,"afterCompact":false},{"index":47,"time":"14:24","ratio":0.491031,"inputTokens":62852,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.435,"originalCredits":0.435,"afterCompact":false},{"index":48,"time":"14:24","ratio":0.497898,"inputTokens":63731,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.384,"originalCredits":0.384,"afterCompact":false},{"index":49,"time":"14:24","ratio":0.500766,"inputTokens":64098,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.369,"originalCredits":0.369,"afterCompact":false},{"index":50,"time":"14:24","ratio":0.50407,"inputTokens":64521,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.391,"originalCredits":0.391,"afterCompact":false},{"index":51,"time":"14:25","ratio":0.508102,"inputTokens":65037,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.356,"originalCredits":0.356,"afterCompact":false},{"index":52,"time":"14:25","ratio":0.510305,"inputTokens":65319,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.434,"originalCredits":0.434,"afterCompact":false},{"index":53,"time":"14:25","ratio":0.517687,"inputTokens":66264,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.372,"originalCredits":0.372,"afterCompact":false},{"index":54,"time":"14:25","ratio":0.519383,"inputTokens":66481,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.379,"originalCredits":0.379,"afterCompact":false},{"index":55,"time":"14:25","ratio":0.522992,"inputTokens":66943,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.35,"originalCredits":0.35,"afterCompact":false},{"index":56,"time":"14:25","ratio":0.524672,"inputTokens":67158,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.368,"originalCredits":0.368,"afterCompact":false},{"index":57,"time":"14:25","ratio":0.52768,"inputTokens":67543,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.448,"originalCredits":0.448,"afterCompact":false},{"index":58,"time":"14:25","ratio":0.533727,"inputTokens":68317,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.514,"originalCredits":0.514,"afterCompact":false},{"index":59,"time":"14:26","ratio":0.541633,"inputTokens":69329,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.395,"originalCredits":0.395,"afterCompact":false},{"index":60,"time":"14:26","ratio":0.543586,"inputTokens":69579,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.349,"originalCredits":0.349,"afterCompact":false},{"index":61,"time":"14:26","ratio":0.545172,"inputTokens":69782,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.363,"originalCredits":0.363,"afterCompact":false},{"index":62,"time":"14:26","ratio":0.547469,"inputTokens":70076,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.39,"originalCredits":0.39,"afterCompact":false},{"index":63,"time":"14:26","ratio":0.551961,"inputTokens":70651,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.497,"originalCredits":0.497,"afterCompact":false},{"index":64,"time":"14:26","ratio":0.559141,"inputTokens":71570,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.793,"originalCredits":0.793,"afterCompact":false},{"index":65,"time":"14:26","ratio":0.578367,"inputTokens":74031,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.522,"originalCredits":0.522,"afterCompact":false},{"index":66,"time":"14:27","ratio":0.581742,"inputTokens":74463,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.509,"originalCredits":0.509,"afterCompact":false},{"index":67,"time":"14:27","ratio":0.589016,"inputTokens":75394,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.497,"originalCredits":0.497,"afterCompact":false},{"index":68,"time":"14:27","ratio":0.594469,"inputTokens":76092,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.422,"originalCredits":0.422,"afterCompact":false},{"index":69,"time":"14:27","ratio":0.597016,"inputTokens":76418,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.391,"originalCredits":0.391,"afterCompact":false},{"index":70,"time":"14:27","ratio":0.598969,"inputTokens":76668,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.404,"originalCredits":0.404,"afterCompact":false},{"index":71,"time":"14:27","ratio":0.601594,"inputTokens":77004,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.493,"originalCredits":0.493,"afterCompact":false},{"index":72,"time":"14:27","ratio":0.607906,"inputTokens":77812,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.46,"originalCredits":0.46,"afterCompact":false},{"index":73,"time":"14:28","ratio":0.612805,"inputTokens":78439,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.418,"originalCredits":0.418,"afterCompact":false},{"index":74,"time":"14:28","ratio":0.614859,"inputTokens":78702,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.373,"originalCredits":0.373,"afterCompact":false},{"index":75,"time":"14:28","ratio":0.615461,"inputTokens":78779,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.452,"originalCredits":0.452,"afterCompact":false},{"index":76,"time":"15:36","ratio":0.380414,"inputTokens":48693,"outputTokens":null,"usageSource":"transcript-ratio","credits":1.884,"originalCredits":1.884,"afterCompact":true},{"index":77,"time":"15:36","ratio":0.424719,"inputTokens":54364,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.629,"originalCredits":0.629,"afterCompact":false},{"index":78,"time":"15:36","ratio":0.429227,"inputTokens":54941,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.343,"originalCredits":0.343,"afterCompact":false},{"index":79,"time":"15:36","ratio":0.432984,"inputTokens":55422,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.315,"originalCredits":0.315,"afterCompact":false},{"index":80,"time":"15:37","ratio":0.435086,"inputTokens":55691,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.846,"originalCredits":0.846,"afterCompact":false},{"index":81,"time":"15:37","ratio":0.461023,"inputTokens":59011,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.474,"originalCredits":0.474,"afterCompact":false},{"index":82,"time":"15:37","ratio":0.463039,"inputTokens":59269,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.339,"originalCredits":0.339,"afterCompact":false},{"index":83,"time":"15:39","ratio":0.466094,"inputTokens":59660,"outputTokens":null,"usageSource":"transcript-ratio","credits":2.15,"originalCredits":2.15,"afterCompact":false},{"index":84,"time":"15:40","ratio":0.553,"inputTokens":70784,"outputTokens":null,"usageSource":"transcript-ratio","credits":1.509,"originalCredits":1.509,"afterCompact":false},{"index":85,"time":"15:41","ratio":0.580828,"inputTokens":74346,"outputTokens":null,"usageSource":"transcript-ratio","credits":1.234,"originalCredits":1.234,"afterCompact":false},{"index":86,"time":"15:42","ratio":0.612852,"inputTokens":78445,"outputTokens":null,"usageSource":"transcript-ratio","credits":1.222,"originalCredits":1.222,"afterCompact":false},{"index":87,"time":"15:42","ratio":0.642297,"inputTokens":82214,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.571,"originalCredits":0.571,"afterCompact":false},{"index":88,"time":"15:42","ratio":0.643039,"inputTokens":82309,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.4,"originalCredits":0.4,"afterCompact":false},{"index":89,"time":"15:42","ratio":0.644719,"inputTokens":82524,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.415,"originalCredits":0.415,"afterCompact":false},{"index":90,"time":"15:42","ratio":0.648477,"inputTokens":83005,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.441,"originalCredits":0.441,"afterCompact":false},{"index":91,"time":"15:42","ratio":0.652695,"inputTokens":83545,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.43,"originalCredits":0.43,"afterCompact":false},{"index":92,"time":"15:42","ratio":0.654867,"inputTokens":83823,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.423,"originalCredits":0.423,"afterCompact":false},{"index":93,"time":"15:43","ratio":0.658609,"inputTokens":84302,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.429,"originalCredits":0.429,"afterCompact":false},{"index":94,"time":"15:43","ratio":0.662438,"inputTokens":84792,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.432,"originalCredits":0.432,"afterCompact":false},{"index":95,"time":"15:43","ratio":0.665891,"inputTokens":85234,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.466,"originalCredits":0.466,"afterCompact":false},{"index":96,"time":"15:43","ratio":0.670883,"inputTokens":85873,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.443,"originalCredits":0.443,"afterCompact":false},{"index":97,"time":"15:43","ratio":0.672641,"inputTokens":86098,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.426,"originalCredits":0.426,"afterCompact":false},{"index":98,"time":"15:43","ratio":0.674539,"inputTokens":86341,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.417,"originalCredits":0.417,"afterCompact":false},{"index":99,"time":"15:43","ratio":0.675953,"inputTokens":86522,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.415,"originalCredits":0.415,"afterCompact":false},{"index":100,"time":"15:43","ratio":0.677359,"inputTokens":86702,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.42,"originalCredits":0.42,"afterCompact":false},{"index":101,"time":"15:44","ratio":0.678969,"inputTokens":86908,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.433,"originalCredits":0.433,"afterCompact":false},{"index":102,"time":"15:44","ratio":0.685422,"inputTokens":87734,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.464,"originalCredits":0.464,"afterCompact":false},{"index":103,"time":"15:44","ratio":0.687305,"inputTokens":87975,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.449,"originalCredits":0.449,"afterCompact":false},{"index":104,"time":"15:46","ratio":0.690039,"inputTokens":88325,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.443,"originalCredits":0.443,"afterCompact":false},{"index":105,"time":"15:52","ratio":0.701953,"inputTokens":89850,"outputTokens":null,"usageSource":"transcript-ratio","credits":5.008,"originalCredits":5.008,"afterCompact":false},{"index":106,"time":"15:52","ratio":0.716766,"inputTokens":91746,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.527,"originalCredits":0.527,"afterCompact":false},{"index":107,"time":"15:54","ratio":0.719414,"inputTokens":92085,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.457,"originalCredits":0.457,"afterCompact":false},{"index":108,"time":"15:55","ratio":0.72057,"inputTokens":92233,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.443,"originalCredits":0.443,"afterCompact":false},{"index":109,"time":"15:55","ratio":0.721531,"inputTokens":92356,"outputTokens":null,"usageSource":"transcript-ratio","credits":0.683,"originalCredits":0.683,"afterCompact":false}],"identity":{"sumAttributed":7713723,"billedInputTokens":7713723,"absDiff":0,"ok":true},"pluginVersion":"2.7.4","selfCmd":"\"C:\\Users\\29670\\.qoder-cn\\plugins\\cache\\qoder-marketplace\\qoder-credits-inspector\\2.7.4\\bin\\credits-inspector.cmd\" cli","linkHealth":{"matched":0,"requests":109,"coverage":0,"usageSource":"transcript-ratio","breakdown":{"proxy":0,"transcriptTokens":0,"transcriptRatio":109},"logRecords":0,"lastRecordAt":null,"recentRequests":0,"proxyErrors":null,"clientAbort":null,"clientAbortMaxMs":null,"upstreamRejected":null,"aborted":null,"truncated":null,"noUsage":null,"slowestMs":null,"supersededFailure":null},"subagents":{"scanned":true,"dir":"C:\\Users\\29670\\.qoder-cn\\projects\\D--UGit-multdc\\c4c64b31-83f6-409f-89bf-cd9bcc89f6e0\\subagents","probedPaths":["C:\\Users\\29670\\.qoder-cn\\projects\\D--UGit-multdc\\c4c64b31-83f6-409f-89bf-cd9bcc89f6e0\\subagents","C:\\Users\\29670\\.qoder-cn\\projects\\c4c64b31-83f6-409f-89bf-cd9bcc89f6e0\\subagents"],"reason":"ok","count":3,"items":[{"agentId":"ageneral-purpose-ce95368b862d6f29","agentType":"general-purpose","description":"Write Data Plane docs","toolUseId":"call_ecdeef7b17674af79e9d4067","roundTrips":14,"billedInputTokens":926445,"peakContextRatio":0.5896,"credits":18.864,"originalCredits":18.864,"error":null},{"agentId":"ageneral-purpose-fe3bc89eb5812d42","agentType":"general-purpose","description":"Write Coordination Plane docs","toolUseId":"call_bc1271200d914d348136cc5a","roundTrips":9,"billedInputTokens":525205,"peakContextRatio":0.5201,"credits":13.85,"originalCredits":13.85,"error":null},{"agentId":"ageneral-purpose-4c5e25e57f3e921f","agentType":"general-purpose","description":"Write Control Plane docs","toolUseId":"call_fbd5761e17dc46ab98397b1f","roundTrips":6,"billedInputTokens":321044,"peakContextRatio":0.4794,"credits":11.955,"originalCredits":11.955,"error":null}],"totals":{"roundTrips":29,"billedInputTokens":1772694,"credits":44.669,"originalCredits":44.669},"combined":{"roundTrips":138,"billedInputTokens":9486417,"credits":116.074,"originalCredits":116.074}},"manual":null,"artifacts":{"report":"report.json","canvas":"使用产品设计的相关技能，梳理当前项目，构建项目架__c4c64b31.canvas.tsx"}} as unknown as Report;

function human(n: number): string {
  if (!isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}

function pct(x: number): string {
  return (x * 100).toFixed(1) + "%";
}

// —— 可用性口径：把 report.availability 翻成人话，并决定某个数字该显示值、「≈」还是「—」——
const AVAIL_LABEL: Record<string, string> = {
  measured: "实测",
  derived: "推导",
  fallback: "回退",
  manual: "手工",
  unavailable: "不可用",
};

const SOURCE_LABEL: Record<string, string> = {
  "desktop-rich": "桌面端富转录",
  "ide-lite": "IDE 端精简转录",
  unknown: "来源未知",
};

function availOf(av: Availability | undefined, key: keyof Availability, dflt: Avail = "measured"): Avail {
  return (av?.[key] as Avail | undefined) ?? dflt;
}

/** 段标题旁的性质标注：实测不标（默认就是实测），其余标出来。 */
function availTag(av: Availability | undefined, key: keyof Availability, dflt: Avail = "measured"): string {
  const v = availOf(av, key, dflt);
  return v === "measured" ? "" : `（${AVAIL_LABEL[v]}）`;
}

/** 不可用的量显示「—」而不是 0：IDE 端的 0 是「读不到」，不是「没发生」。 */
function orDash(
  v: number,
  av: Availability | undefined,
  key: keyof Availability,
  fmt: (n: number) => string = String
): string {
  return availOf(av, key) === "unavailable" ? "—" : fmt(v);
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "read":
      return "读取";
    case "write":
      return "写入";
    case "search":
      return "搜索";
    case "shell":
      return "命令";
    default:
      return "其他";
  }
}

function shortTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const p = (v: number) => String(v).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function SessionTokensReport() {
  if (!REPORT) {
    return (
      <ReportShell width="wide" ariaLabel="会话 token 消耗截析">
        <Stack gap="component">
          <H1>会话 token 消耗截析</H1>
          <Text tone="secondary">报告数据尚未注入。请在会话中触发一次 Stop 钩子，或运行 CLI 生成 report.json。</Text>
        </Stack>
      </ReportShell>
    );
  }

  const r = REPORT;
  const s = r.session;
  const c = r.context;
  const t = r.totals;
  const av = r.availability;
  const manual = r.manual ?? null;
  const sourceLabel = SOURCE_LABEL[r.source ?? "unknown"] ?? "来源未知";
  // 有没有 usage 决定整份报告是「真值/推导」还是「一律 —」。手工回填的 credits 不算有 usage，
  // 否则下面按 ratio 推导的图表会照画一堆 0。
  const hasUsage = availOf(av, "roundTrips") === "measured";
  const manualCredits = manual?.credits ?? null;

  // 报告里出现的命令一律用数据层注入的插件入口（Windows 上是自带启动器的绝对路径，免装 Node）。
  // 旧报告没有这个字段时回退原写法，不比改动前更差。
  const CLI = r.selfCmd || "node scripts/cli.mjs";

  // credits 覆盖范围：credits 与「计费输入总量」并排放在头部，读者一除就得到单价。
  // 混合会话里 credits 只来自转录路径的那几笔（实测某会话 413 笔里只有 1 笔带 credits），
  // 部分覆盖不说出来 = 把局部真值当全量展示。
  const cov = r.creditsCoverage ?? null;
  const covPartial = !!(cov && !cov.full && cov.roundTrips > 0);
  const covNote = covPartial ? ` · 仅覆盖 ${cov!.trips}/${cov!.roundTrips} 笔往返（占计费输入 ${pct(cov!.tokenShare)}）` : "";

  // 缓存命中：代理记录里一直带着 cachedTokens，此前采集了却从不呈现。
  const cachedMeasured = availOf(av, "cachedTokens") === "measured";
  const cachedText = cachedMeasured
    ? `输入 ${human(t.billedInputTokens)}，其中缓存命中 ${human(t.cachedTokens ?? 0)}（${pct(t.cachedShare ?? 0)}，${t.cachedTrips ?? 0} 笔往返带缓存）——供应商对重复叠加的前缀打折，故按 token 数的节省大于按计费的节省。`
    : "";

  // 代理告警只在「失败记录仍然成立」时才报：status.json 只写不清，陈旧失败会把用户推去改
  // 本来正确的 Base URL，越修越坏；而同一份报告里的 lastRecordAt / matched 是它在跑的硬证据。
  const proxyAlarm = r.proxy?.status && !r.proxy.statusSuperseded ? r.proxy.status : null;
  const proxyAlive = !proxyAlarm && (r.proxy?.logRecords ?? 0) > 0;

  // 官方 UI 一场会话扣费 = 主链 + 子代理，故有子代理时 headline 必须给 combined，否则比 UI 少一截
  const creditScope =
    r.subagents && r.subagents.count > 0
      ? {
          credits: r.subagents.combined.credits,
          note: `主链 ${t.credits} + 子代理 ${r.subagents.totals.credits} · 原始 ${r.subagents.combined.originalCredits}`,
        }
      : { credits: t.credits, note: `原始 ${t.originalCredits}（实测）` };

  const headline: MetricItem[] = [
    {
      label: "计费输入总量",
      value: hasUsage ? human(t.billedInputTokens) : "—",
      description: hasUsage
        ? availOf(av, "tokens") === "measured"
          ? `Σ prompt_tokens（实测真值）${covPartial ? ` · 覆盖全部 ${cov!.roundTrips} 笔往返` : ""}`
          : `Σ 上下文 × 往返${availTag(av, "tokens", "derived")}${covPartial ? ` · 覆盖全部 ${cov!.roundTrips} 笔往返` : ""}`
        : "转录无 usage",
    },
    {
      label: "当前上下文",
      value: hasUsage ? human(t.netContextTokens) : "—",
      description: hasUsage
        ? `峰值 ${pct(c.peakContextRatio)}${s.compactions ? "（压缩后起算）" : ""}`
        : "转录无 usage",
    },
    {
      label: "重发放大",
      value: hasUsage ? `${t.amplification}×` : "—",
      description: `往返 ${hasUsage ? `${s.roundTrips} 次` : "—"}`,
    },
    {
      label: "Credits",
      // 代理路径（自定义模型）token 是实测真值但 credits 无来源：hasUsage 为真也要显示「—」，
      // 否则 t.credits=0 会被读成「这次没花钱」。
      value:
        manualCredits != null
          ? `${manualCredits}`
          : hasUsage && availOf(av, "credits") !== "unavailable"
            ? `${creditScope.credits}`
            : "—",
      description:
        manualCredits != null
          ? `官方 UI 手工录入 · 本地 ${creditScope.credits}`
          : hasUsage && availOf(av, "credits") !== "unavailable"
            ? `${creditScope.note}${covNote}`
            : r.usageSource === "proxy" || r.usageSource === "transcript-tokens" || r.usageSource === "mixed"
              ? "自定义模型（BYOK）不经 Qoder 计费网关，无 credits 真值"
              : hasUsage
                ? "转录带 usage 但没有 credits 字段，本地无计费真值"
                : "本地不可用，见下方告警",
    },
  ];

  const pieData = r.byCategory.map((x) => ({ label: x.label, value: x.tokens }));

  // 系统提示词是报告里少数「用户能直接动」的一项：它每轮被完整重发，总量 = 每请求规模 × 往返数，
  // 而它的大小由装了多少插件与技能决定。占比小时不必啰嗦。
  const sysCat = r.byCategory.find((x) => x.key === "system");
  const sysNote =
    hasUsage && sysCat && sysCat.share >= 0.1
      ? ` 系统提示词占 ${pct(sysCat.share)}（${human(c.systemPromptTokens)}/请求 × ${s.roundTrips} 次往返 = ${human(sysCat.tokens)}）：它每轮都被完整重发，大小由你装了多少插件与技能决定，精简技能能直接压低这一项——本插件自己的技能描述也常驻在里面（约 170 token）。`
      : "";

  const tools = r.byTool.slice(0, 8);
  const toolCategories = tools.map((x) => x.tool);
  const toolSeries = [{ name: "重发 tokens", data: tools.map((x) => x.tokens) }];
  // 「单次」= 平均每次调用带来的重发 token。总量榜会埋掉次数少但每次极贵的工具：
  // 实测 Read 只 29 次却吃 335 万，单次是 Edit 的 2.6 倍。
  const toolRows = tools.map((x) => [
    x.tool,
    human(x.tokens),
    pct(x.share),
    String(x.calls),
    x.perCall == null ? "—" : human(x.perCall),
  ]);

  const files = r.byFile.slice(0, 20);
  const fileRows = files.map((f) => [
    f.label,
    kindLabel(f.kind),
    human(f.billed),
    pct(f.share),
    f.perRead == null ? "—" : human(f.perRead),
    String(f.trips),
    String(f.reads),
  ]);

  const byReq = r.byRequest ?? [];
  const reqLabels = byReq.map((x, i) => x.time || `#${x.index ?? i + 1}`);
  const reqInputs = byReq.map((x) => x.inputTokens);
  const reqCredits = byReq.map((x) => x.credits);
  // credits 只在覆盖全部往返时才画曲线：部分覆盖（BYOK 混合会话实测 413 笔里 1 笔有 credits）
  // 画出来是一地零，既读不出形状，还会暗示「其余往返没花钱」。
  const showCreditsChart = hasUsage && !covPartial && availOf(av, "credits") !== "unavailable";

  // 按类别下钻：类别小计行（accent/neutral）+ 其工具/文件明细行（default），用 rowTone 分组着色。
  const catDetail = r.byCategoryDetail ?? [];
  const detailRows: string[][] = [];
  const detailTones: ("accent" | "neutral" | "default")[] = [];
  for (const cc of catDetail) {
    const hasKids = cc.children.length > 0;
    detailRows.push([cc.label, "—", hasKids ? "小计" : "（整体，无工具/文件归属）", human(cc.tokens), pct(cc.share), "100%", "—"]);
    detailTones.push(hasKids ? "accent" : "neutral");
    for (const k of cc.children) {
      detailRows.push(["", k.tool || "—", k.label, human(k.tokens), pct(k.share), pct(k.catShare), String(k.trips)]);
      detailTones.push("default");
    }
  }

  // 子代理账：Agent 派发的子代理消耗不在主链里，单独一段呈现（无子代理则整段不渲染）。
  const sub = r.subagents;
  const subItems = sub?.items ?? [];
  const subRows: string[][] = [];
  const subTones: ("accent" | "default")[] = [];
  for (const a of subItems) {
    subRows.push([
      a.description || a.agentId,
      a.agentType || "—",
      String(a.roundTrips),
      human(a.billedInputTokens),
      pct(a.peakContextRatio),
      String(a.credits),
      String(a.originalCredits),
      a.error || "—",
    ]);
    subTones.push("default");
  }
  if (sub && subItems.length > 0) {
    subRows.push([
      "合计（主链 + 子代理）",
      "—",
      String(sub.combined.roundTrips),
      human(sub.combined.billedInputTokens),
      "—",
      String(sub.combined.credits),
      String(sub.combined.originalCredits),
      `主链 ${t.credits} / 子代理 ${sub.totals.credits}`,
    ]);
    subTones.push("accent");
  }

  // 压缩单笔成本：输入/摘要一律取数据层归一后的生效值（有代理实测就是实测，否则是客户端自估），
  // 并用「口径」列把两者分开——混着显示会让自估值被当成实测。
  const ccost = r.compactionCost;
  const ccItems = ccost?.items ?? [];
  const compactRows: string[][] = ccItems.map((e) => [
    `#${e.index}`,
    shortTime(e.at),
    e.trigger || "—",
    e.effectiveInputTokens == null ? "—" : human(e.effectiveInputTokens),
    e.effectiveOutputTokens == null ? "—" : human(e.effectiveOutputTokens),
    e.nextInputTokens == null ? "—" : human(e.nextInputTokens),
    e.savedTokens == null ? "—" : human(e.savedTokens),
    e.proxy && e.proxy.ms != null ? `${Math.round(e.proxy.ms / 1000)}s` : "—",
    e.proxy ? "实测" : "自估",
  ]);

  // IDE 端仅剩的真值：工具调用次数与文件读取次数（不依赖 usage，两种转录都写 tool_use 块）。
  const residueRows: string[][] = [];
  if (!hasUsage) {
    for (const x of r.byTool.filter((v) => v.calls > 0).sort((a, b) => b.calls - a.calls).slice(0, 15)) {
      residueRows.push([x.tool, "工具", String(x.calls), "—", "—"]);
    }
    for (const f of r.byFile.filter((v) => v.reads > 0).sort((a, b) => b.reads - a.reads).slice(0, 15)) {
      residueRows.push([f.label, kindLabel(f.kind), "—", String(f.reads), String(f.trips)]);
    }
  }

  // A1 三值：一次带 usage 的往返都没有时 0 <= max(2,0) 恒成立，会把「没数据」判成「校验通过」，
  // 故 breakdown.mjs 在 reqCount===0 时给 null；这里必须显示「不适用」而不是绿色通过。
  const identityText =
    r.identity.ok == null
      ? "恒等式 A1 不适用（本转录没有一次带 usage 的往返）。"
      : r.identity.ok
        ? `归因覆盖 ${pct(t.coverage)}${availTag(av, "categoryShare", "derived")}，恒等式 A1 通过（|Δ|=${r.identity.absDiff}）。`
        : `归因覆盖 ${pct(t.coverage)}，恒等式 A1 未通过（|Δ|=${r.identity.absDiff}）。`;
  // 窗口读不到时是静默回退的 200000，而所有 token 数字都乘它 —— 必须显式标 ≈ 与来源。
  const cwIsFallback = availOf(av, "contextWindow") === "fallback";
  const cwText = cwIsFallback ? `≈${human(c.contextWindow)}（回退值）` : human(c.contextWindow);
  // 当前占用头条：以最新上下文（currentContextTokens）为准；段内单调递增 ⇒ 旧版峰值与当前恒等，故合并为一条。
  const curCtx = c.currentContextTokens ?? c.peakContextTokens;
  const netAdv = c.netUserAdvice || c.peakUserAdvice || c.peakAdvice || null;
  const limitSrcLabel =
    c.userContextLimitSource === "manual" ? "手工"
    : c.userContextLimitSource === "config" ? "配置"
    : c.userContextLimitSource === "derived" ? "实测反推"
    : "默认";
  // 阈值来源非 manual/config/derived ⇒ 用的是内置兜底 200K，不是用户在 Qoder 设的真值，需显式提示如何改。
  const limitIsDefault = c.userContextLimitSource !== "manual" && c.userContextLimitSource !== "config" && c.userContextLimitSource !== "derived";
  // 上下文对比表：把旧版挤成一段小字的「界面显示 / 自动压缩实况 / 历史高点」拆成可扫读的行，无数据不占位。
  const ctxRows: string[][] = [];
  if (c.userContextLimit != null && Number.isFinite(c.contextWindow)) {
    ctxRows.push(
      c.contextWindow > c.userContextLimit
        ? ["Qoder 界面进度条", pct(c.netWindowRatio ?? c.peakContextRatio), `按模型物理窗口 ${cwText} 算，比你真实占比低约 ${(c.contextWindow / c.userContextLimit).toFixed(1)} 倍——界面显得偏空、有迷惑性，别信它`]
        : ["Qoder 界面进度条", pct(c.netWindowRatio ?? c.peakContextRatio), `按模型窗口 ${cwText} 算，与你实设上限一致，显示无偏差`],
    );
  }
  if (c.observedAutoCompactions != null && c.observedAutoCompactions > 0 && c.observedAutoTriggerTokens != null) {
    ctxRows.push(["自动压缩实况", `自动 ${c.observedAutoCompactions} 次`, `触发点在 ~${human(c.observedAutoTriggerTokens)}（窗口的 ${pct(c.autoTriggerRatio ?? 0)}）`]);
  } else if (s.compactions > 0) {
    ctxRows.push(["压缩实况", `手动 ${s.compactions} 次`, "本场未见自动压缩，均为你手动触发"]);
  }
  if (c.peakSessionNotable) {
    ctxRows.push(["压缩前历史高点", `${pct(c.peakSessionRatio ?? 0)}（${human(c.peakSessionTokens ?? 0)}）`, "本场曾达到的最高占用"]);
  }

  // 链路健康度：把 --request-log 的逐笔归因压成一行结论（明细属于排障，留在 CLI）。
  // 分两档：本会话确实走在代理链路上（proxy/mixed）才印「最近 N 笔」的失败统计与排障命令；
  // token 全来自转录的会话里，那些统计说的是别的会话，印成 warning + 命令是噪音，只留覆盖率与最近记录时间。
  // 纯官方模型用户从没配过代理，整行不渲染。
  const lhRaw = r.linkHealth ?? null;
  const lh = lhRaw && (r.proxy?.configured || lhRaw.matched > 0) ? lhRaw : null;
  const lhOnPath = !!lh && (lh.matched > 0 || lh.usageSource === "proxy" || lh.usageSource === "mixed");
  const lhErrors = lh ? lh.proxyErrors ?? 0 : 0;
  const lhBad = lhOnPath && lhErrors > 0;
  const lhTone: "info" | "warning" = lhBad ? "warning" : "info";
  // 三档拆分一行说清：代理实测 / 转录 input_tokens / 转录 ratio×window 各多少笔。
  // 旧报告（v3）无 breakdown 字段时退回到只报 matched。
  const lhBd = lh?.breakdown ?? null;
  const lhBdText = lhBd
    ? `拆分：代理 ${lhBd.proxy} 笔 · 转录 input_tokens ${lhBd.transcriptTokens} 笔 · 转录 ratio×窗口 ${lhBd.transcriptRatio} 笔`
    : "";
  const lhSrcNote = !lh
    ? ""
    : lh.usageSource === "proxy"
      ? "：全部为供应商实测"
      : lh.usageSource === "transcript-tokens"
        ? "：本会话 token 全来自转录 input_tokens（BYOK，代理未在链路上）"
        : lh.usageSource === "transcript-ratio"
          ? "：本会话 token 由 ratio×窗口推导（官方模型）"
          : lh.usageSource === "mixed"
            ? "：多源混合，以下拆分列为准"
            : lh.usageSource === "transcript"
              ? "：本会话 token 全部来自转录，代理不在链路上"
              : "";
  const lhText = !lh
    ? ""
    : [
        lh.requests > 0
          ? `代理覆盖 ${lh.matched}/${lh.requests} 笔往返（${pct(lh.coverage)}）${lhSrcNote}`
          : "本会话没有带 usage 的往返，代理无从覆盖",
        lhBdText,
        lh.lastRecordAt ? `代理最近记录 ${shortTime(lh.lastRecordAt)}` : proxyAlive ? "代理有记录但无时间戳" : "代理从未记到流量",
        lhOnPath && lh.recentRequests
          ? `最近 ${lh.recentRequests} 笔：代理失败 ${lh.proxyErrors} · 上游报错 ${lh.upstreamRejected} · 客户端提前断开 ${lh.aborted} · 成功但无 usage ${lh.noUsage}${
              lh.slowestMs != null ? ` · 最慢 ${Math.round(lh.slowestMs / 1000)}s` : ""
            }`
          : lhOnPath
            ? "请求诊断日志为空（运行中的代理是旧版，或还没记到）"
            : "",
        lhBad ? `有「代理失败」= 请求没出得去或代理自己抛了，跑 ${CLI} --request-log 看归因` : "",
        !lhOnPath && lhErrors > 0 ? `代理另有 ${lhErrors} 笔失败，属于走代理的那些会话` : "",
        lh.supersededFailure
          ? `${shortTime(lh.supersededFailure.at ?? null)} 那条「拉起失败（${lh.supersededFailure.error}）」已被之后的流量推翻，无需处理`
          : "",
      ]
        .filter(Boolean)
        .join("。") + "。";

  return (
    <ReportShell width="wide" ariaLabel="会话 token 消耗截析">
      <Stack gap="sectionCompact">
        <header>
          <Stack gap="component">
            <H1>会话 token 消耗截析</H1>
            <Text tone="secondary">
              {s.model || "未知模型"}
              {s.modelSource === "manual" ? "（手工录入）" : ""} · {sourceLabel} · 会话{" "}
              {String(s.id || "").slice(0, 8)}
              {s.title ? `「${s.title}」` : ""} · {shortTime(s.startedAt)} →{" "}
              {shortTime(s.endedAt)} · 压缩{" "}
              {availOf(av, "compactions") === "unavailable" ? "—" : `${s.compactions} 次`}
              {r.usageSource ? ` · usage 来源 ${
                r.usageSource === "proxy"
                  ? "代理实测"
                  : r.usageSource === "transcript-tokens"
                    ? "转录 input_tokens"
                    : r.usageSource === "transcript-ratio"
                      ? "转录 ratio×窗口"
                      : r.usageSource === "mixed"
                        ? "多源混合"
                        : "转录"
              }` : ""}
              {r.pluginVersion ? ` · v${r.pluginVersion}` : ""} · schema v{r.schemaVersion}
            </Text>
            <MetricsGrid variant="header" columns={4} items={headline} />
          </Stack>
        </header>

        {!hasUsage && r.source === "desktop-rich" && (
          <Callout tone="danger" title="本报告数值不可用：自定义模型（BYOK）不经 Qoder 计费网关">
            转录是桌面端富布局，但 assistant entry 里没有 message.usage——自定义模型（如千问
            tokenplan）的响应不经 Qoder 计费网关，credits / context_usage_ratio 无来源，提供商返回的
            usage 客户端也不落盘（已实测扫过 ~/.qoder-cn、~/.qoder、~/.qoder-cli 与 %APPDATA%\QoderCN）。
            本地补救（改一个配置文件即可，免装 Node、之后全自动）：编辑 {"`~/.qoder-credits-proxy/config.json`"}，
            把 {"`upstream`"} 填成你的供应商根地址（= Base URL 去掉结尾 /v1），再把自定义模型 Base URL 的 host:port
            换成 {`127.0.0.1:${r.proxy?.port ?? 49787}`}（路径保留），新开一个会话即自动拉起代理、按 message.id
            精确 join 出实测 token（credits 仍无真值）。装了 Node 也可用 {"`--setup-proxy`"} / {"`--check-proxy`"} 一步到位。
            手工回填通道同样可用：
            {"`.qoder-credits/overrides/<sessionId>.json`"}。
          </Callout>
        )}

        {!hasUsage && r.source !== "desktop-rich" && (
          <Callout tone="danger" title="本报告数值不可用：转录不含 message.usage">
            这是 {sourceLabel}（IDE 端客户端）。它的转录只写 session_meta / user / assistant / progress 四种 entry，
            message.usage 整个字段不存在，也不落到本地任何其它文件（已实测扫过 ~/.qoder-cn、~/.qoder、
            ~/.qoder-cli 与 %APPDATA%\QoderCN）。因此 Credits、token 与各类占比一律显示「—」而不是 0 ——
            0 会被误读成「这次没花钱」。真值只有官方 UI 有：把它填进{" "}
            {"`.qoder-credits/overrides/<sessionId>.json`"} 后重跑，上方会出现「官方 UI 真值」一段并与本地并列对账。
          </Callout>
        )}

        {manual && (
          <Callout tone="success" title="官方 UI 真值（手工录入，未覆盖任何本地数字）">
            Credits {manual.credits ?? "—"} · 原价 {manual.originalCredits ?? "—"}
            {manual.model ? ` · 模型 ${manual.model}` : ""}
            {manual.durationMin != null ? ` · 时长 ${manual.durationMin} min` : ""}
            {manual.startedAt ? ` · ${shortTime(manual.startedAt)}` : ""}
            {manual.localCoverage != null
              ? ` · 本地${manual.localScope === "combined" ? "合计（主链+子代理）" : "主链"} ${manual.localCredits ?? t.credits}，覆盖 ${pct(manual.localCoverage)}`
              : " · 本地无 usage，无法对账"}
            {manual.note ? `。备注：${manual.note}` : ""}
          </Callout>
        )}

        {sub && sub.count === 0 && sub.reason && sub.reason !== "no-dir" && (
          <Callout tone="warning" title={`子代理账未汇总（${sub.reason}）`}>
            探测过的候选目录：{(sub.probedPaths ?? []).join("  |  ") || "（无）"}
          </Callout>
        )}

        {proxyAlarm && (
          <Callout tone="warning" title={`代理自动启动失败（${proxyAlarm.error}）`}>
            {proxyAlarm.error === "EADDRINUSE"
              ? `端口 ${proxyAlarm.port ?? "—"} 被占用，自定义模型将无法对话。请换一个空闲端口重启代理：${CLI} --setup-proxy --port <新端口>，并把模型 Base URL 改成新端口。`
              : `代理未就绪（${proxyAlarm.error}），自定义模型可能无法对话。请运行 ${CLI} --check-proxy 查看链路状态。`}
          </Callout>
        )}

        {r.proxy?.dormant && !proxyAlarm && (
          <Callout tone="info" title="代理长期空闲">
            代理已配置但超过 14 天没有记录到流量（可能你已改回官方模型）。如不再使用自定义模型，可运行{" "}
            {CLI} --stop-proxy 停用代理；保留也不影响官方模型。
          </Callout>
        )}

        {cwIsFallback && (
          <Callout tone="warning" title="上下文窗口为回退值 200K（未从 runtime-config / usage 反推 / ManualTruth 拿到真值）">
            本会话所有以窗口为分母的占比与「峰值建议」都可能偏大，而绝对 token 数（已改以 S 真值为底）不受影响。
            建议在 {"`.qoder-credits/overrides/<sessionId>.json`"} 里手工填 {"`contextWindow`"}（如 qwen3-max=1000000），或等一笔带 input_tokens+ratio 的往返写入转录后自动反推生效。
          </Callout>
        )}

        {hasUsage && netAdv && c.userContextLimit != null && (
          <Stack gap="component">
            <Callout
              tone={netAdv.tone}
              title={`你真实的上下文占用 ${pct(c.netUserRatio ?? c.peakUserRatio ?? 0)}（${human(curCtx)} / 阈值 ${human(c.userContextLimit)}・${limitSrcLabel}）`}
            >
              {netAdv.text}
              {limitIsDefault && (
                <Text tone="secondary">
                  {` ⚙ 这里的 ${human(c.userContextLimit)} 是插件内置默认值，不是你在 Qoder「模型管理」里设的真实上限（插件读不到那个设置）。想按真实阈值算：在 ~/.qoder-credits-proxy/config.json 填 "userContextLimit": <你的上限>（对所有会话生效），或对本会话在 .qoder-credits/overrides/<会话id>.json 填同名字段，重跑报告即生效。`}
                </Text>
              )}
            </Callout>
            {ctxRows.length > 0 && (
              <Table
                headers={["对比口径", "数值", "说明"]}
                rows={ctxRows}
                density="compact"
              />
            )}
          </Stack>
        )}

        {c.thresholdNotEnforced && (
          <Callout tone="warning" title="⚠ 自动压缩不会在你设的阈值触发（本条最重要）">
            你的模型物理窗口是 {cwText}，Qoder 的自动压缩要等上下文涨到窗口 ~85%（≈{human(Math.round(c.contextWindow * 0.85))}）才触发；
            你在模型管理里设的 {human(c.userContextLimit)} 上限远在其下，永远不会触发自动压缩。
            请照上面「你真实的上下文占用」那条，到点自己手动压缩，别等它自动压。
          </Callout>
        )}

        {lh && (
          <Callout tone={lhTone} title="链路健康度">
            {lhText}
          </Callout>
        )}

        <Callout tone="info" title="度量口径">
          计费输入总量逐笔锁定真值（优先级：代理 promptTokens &gt; 转录 usage.input_tokens &gt; ratio{availTag(av, "contextRatio")} × {cwText}
          {cwIsFallback ? "，未拿到真窗口、全部 token 数字随之带 ≈" : ""}）；各类别/文件按块估算规模比例分摊
          {availTag(av, "categoryShare", "derived")}。{identityText}
          {cachedText ? ` ${cachedText}` : ""}
          {covPartial
            ? ` Credits 只来自 ${cov!.trips}/${cov!.roundTrips} 笔往返（占计费输入 ${pct(cov!.tokenShare)}），其余往返走代理实测、不经 Qoder 计费，故不要拿 Credits 去除以计费输入总量算单价。`
            : ""}
        </Callout>

        {byReq.length > 0 && (
          <ReportSection
            title="逐请求明细（每一次往返）"
            description={
              showCreditsChart
                ? "每个 round-trip 的真实输入规模与 credits；曲线骤降处为上下文压缩重置（顶部四项为会话累计，此处为每一次）"
                : `每个 round-trip 的真实输入规模；曲线骤降处为上下文压缩重置。credits 曲线未画：本会话只有 ${cov?.trips ?? 0}/${cov?.roundTrips ?? byReq.length} 笔往返带 credits（其余走代理实测、不经 Qoder 计费），画出来是一地零。`
            }
            meta={`${byReq.length} 次往返 · 压缩 ${orDash(s.compactions, av, "compactions")} 次`}
            divided
          >
            {showCreditsChart ? (
              <ChartComparisonGrid>
                <ChartContainer title="每次输入 tokens" ariaLabel="每次输入 tokens">
                  <LineChart
                    categories={reqLabels}
                    series={[{ name: "输入 tokens", data: reqInputs, tone: "info" }]}
                    height={220}
                    valueFormatter={human}
                    ariaLabel="每次请求输入 tokens"
                  />
                </ChartContainer>
                <ChartContainer title="每次 credits" ariaLabel="每次 credits">
                  <LineChart
                    categories={reqLabels}
                    series={[{ name: "credits", data: reqCredits, tone: "warning" }]}
                    height={220}
                    ariaLabel="每次请求 credits"
                  />
                </ChartContainer>
              </ChartComparisonGrid>
            ) : (
              <ChartContainer title="每次输入 tokens" ariaLabel="每次输入 tokens">
                <LineChart
                  categories={reqLabels}
                  series={[{ name: "输入 tokens", data: reqInputs, tone: "info" }]}
                  height={220}
                  valueFormatter={human}
                  ariaLabel="每次请求输入 tokens"
                />
              </ChartContainer>
            )}
          </ReportSection>
        )}

        {hasUsage && ccItems.length > 0 && (
          <ReportSection
            title="压缩单笔成本（会话里最贵的那几笔调用）"
            description="每次压缩本身就是一笔普通模型调用：整份上下文当 prompt 进去、摘要当 completion 出来。此前报告只显示「压缩 N 次」，把单笔最贵的开销藏成了一个计数。「省下」= 压缩前规模 − 压缩后首轮实测输入（地板）。口径列：实测=能在代理日志里唯一对上的供应商真值；自估=客户端在压缩边界里写的前后规模。"
            meta={`${ccItems.length} 次 · 输入累计 ${human(ccost?.totals.preTokens ?? 0)} · 摘要累计 ${human(ccost?.totals.postTokens ?? 0)} · 累计省下 ${human(ccost?.totals.savedTokens ?? 0)} · 其中 ${ccost?.totals.measured ?? 0} 笔为供应商实测`}
            divided
          >
            <Table
              headers={["第几次", "时刻", "触发", "输入", "摘要输出", "压缩后首轮", "省下", "耗时", "口径"]}
              rows={compactRows}
              density="compact"
              stickyHeader
            />
          </ReportSection>
        )}

        {sub && subItems.length > 0 && (
          <ReportSection
            title="子代理账（Agent 派发）"
            description="子代理的每次往返只写进它自己的独立转录，不计入上方主链任何数字；官方 UI 的一场会话扣费 = 主链 + 各子代理。"
            meta={`${subItems.length} 个子代理 · 主链 ${t.credits} + 子代理 ${sub.totals.credits} = 合计 ${sub.combined.credits} Credits`}
            divided
          >
            <Table
              headers={["子代理", "类型", "往返", "计费输入", "峰值占比", "Credits", "原价", "备注"]}
              rows={subRows}
              rowTone={subTones}
              density="compact"
              stickyHeader
            />
          </ReportSection>
        )}

        {hasUsage && r.byCategory.length > 0 && (
          <ReportSection
            title="按类别占比"
            description={`会话计费输入 token 在各来源间的分布（完整划分，占比之和 = 100%）${sysNote}`}
            meta={human(t.billedInputTokens) + ` tokens${availTag(av, "categoryShare", "derived")}`}
            divided
          >
            <ChartContainer ariaLabel="按类别占比">
              <PieChart donut data={pieData} centerLabel="计费输入" valueFormatter={human} />
            </ChartContainer>
          </ReportSection>
        )}

        {hasUsage && catDetail.length > 0 && (
          <ReportSection
            title="按类别下钻（工具 / 文件路径）"
            description="每个类别的消耗再拆到工具与具体文件/路径：工具返回、工具调用可精确到路径，其余类别为整体（无文件归属）。数值均为重发计费 token。"
            meta={`占总额=占计费输入总量 · 占本类=占该类别 · 程数=存活往返累计${availTag(av, "fileShare", "derived")}`}
            divided
          >
            <Table
              headers={["类别", "工具", "文件 / 路径", "重发 tokens", "占总额", "占本类", "程数"]}
              rows={detailRows}
              rowTone={detailTones}
              density="compact"
              stickyHeader
            />
          </ReportSection>
        )}

        {hasUsage && tools.length > 0 && (
          <ReportSection
            title="按工具占比"
            description="各工具相关内容（调用参数 + 返回）重发累计的计费 token 占比（仅工具相关块，非完整划分，占比之和 < 100%）。「单次」= 平均每次调用带来的重发 token：总量榜会把「次数少但每次极贵」的工具埋掉，这一列专门把它捞出来。"
            meta={`token 占比${availTag(av, "toolShare", "derived")} · 调用次数为实测`}
            divided
          >
            <Stack gap="component">
              <ChartContainer ariaLabel="按工具占比">
                <BarChart horizontal categories={toolCategories} series={toolSeries} valueFormatter={human} ariaLabel="按工具占比" />
              </ChartContainer>
              <Table
                headers={["工具", "重发 tokens", "占比", "调用", "单次"]}
                rows={toolRows}
                density="compact"
                stickyHeader
              />
            </Stack>
          </ReportSection>
        )}

        {hasUsage && fileRows.length > 0 && (
          <ReportSection
            title="按文件占比"
            description="精确到路径/文件名：内容随上下文被重复发送累计的计费 token 占比（Top 20，仅可归因文件的块）。「单次读取」= 这个文件平均每次被读取最终烧掉多少（含此后每一程的重发）——读一次就烧掉十几万的文件，在按总量排序的榜上毫不起眼。"
            meta={`程数=存活往返累计 · 读取=返回次数（实测）${availTag(av, "fileShare", "derived")}`}
            divided
          >
            <Table
              headers={["文件", "种类", "重发 tokens", "占比", "单次读取", "程数", "读取"]}
              rows={fileRows}
              density="compact"
              stickyHeader
            />
          </ReportSection>
        )}

        {!hasUsage && residueRows.length > 0 && (
          <ReportSection
            title="工具调用与文件读取（计数为实测）"
            description="占比与 token 一律不可用，但 tool_use 块两种转录都写，所以「谁被调了几次、谁被读了几次」仍是真值 —— IDE 端不是一无所有。"
            meta={`${t.toolCalls ?? 0} 次工具调用${availTag(av, "toolCalls")} · ${t.fileReads ?? 0} 次文件读取${availTag(av, "fileReads")} · ${s.turns} 轮对话`}
            divided
          >
            <Table
              headers={["工具 / 文件", "种类", "调用", "读取", "程数"]}
              rows={residueRows}
              density="compact"
              stickyHeader
            />
          </ReportSection>
        )}
      </Stack>
    </ReportShell>
  );
}

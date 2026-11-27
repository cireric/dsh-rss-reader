/**
 * 内置精选源快照（R15 08，spec §4.3.1 / §5.1）。
 *
 * 来源：`docs/misc/zh-rss-feeds.opml` —— 「中文高价值 RSS 源 · 实测可用 79 条」，采集日 2026-10-10。
 * 该文件被 gitignore，不会出现在 worktree / 发布包里；运行时去读它在用户机器上必然 ENOENT，
 * 所以清单必须固化进源码。它是**快照**而不是订阅：只在 config.json 的 curatedSources 字段
 * 不存在时用于首次初始化（字段存在但为空数组 = 用户删光了，绝不回填，见 src/source-pack.ts）。
 *
 * `addedAt` 用采集日而不是逐条的真实添加时间：这份清单没有逐条时间，编一个更具体的时间是
 * 伪造数据；采集日是唯一有据可查的日期。
 */
import type { CuratedSourceEntry } from './shared.js'

/** 快照采集日（OPML 文件头写明）。 */
export const CURATED_SEED_COLLECTED_AT = '2026-10-10'

/** 种子条目的 `addedAt`：只到日，按 UTC 零点落成完整时刻串（与库里其他时刻串同形）。 */
const CURATED_SEED_ADDED_AT = '2026-10-10T00:00:00.000Z'

/** 快照元信息：界面用来说明「这些不是你的条目，是内置清单」。 */
export const CURATED_SEED_META = { collectedAt: CURATED_SEED_COLLECTED_AT, count: 79 } as const

export const CURATED_SEED: readonly CuratedSourceEntry[] = [
  { url: 'https://www.kawabangga.com/feed', title: '卡瓦邦噶', category: '科技 / 工程博客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.leavesongs.com/feed/', title: '离别歌', category: '科技 / 工程博客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://colobu.com/atom.xml', title: '鸟窝 colobu', category: '科技 / 工程博客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://blog.devtang.com/atom.xml', title: '唐巧的技术博客', category: '科技 / 工程博客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.jeffjade.com/atom.xml', title: '晚晴幽草轩', category: '科技 / 工程博客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://blog.lilydjwg.me/feed', title: '依云', category: '科技 / 工程博客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://blog.codingnow.com/atom.xml', title: '云风的 BLOG', category: '科技 / 工程博客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.zhangxinxu.com/wordpress/feed/', title: '张鑫旭', category: '科技 / 工程博客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://juejin.cn/rss', title: '掘金', category: '开源与开发者社区', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.cnbeta.com.tw/backend.php', title: 'cnBeta', category: '开源与开发者社区', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://cnodejs.org/rss', title: 'CNode 社区', category: '开源与开发者社区', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://hellogithub.com/rss', title: 'HelloGitHub', category: '开源与开发者社区', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.infoq.cn/feed', title: 'InfoQ 中文', category: '开源与开发者社区', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://ruby-china.org/topics/feed', title: 'Ruby China', category: '开源与开发者社区', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://segmentfault.com/feeds/questions', title: 'SegmentFault 问答', category: '开源与开发者社区', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://segmentfault.com/feeds', title: 'SegmentFault feeds', category: '开源与开发者社区', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.solidot.org/index.rss', title: 'Solidot 奇客', category: '开源与开发者社区', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.v2ex.com/index.xml', title: 'V2EX', category: '开源与开发者社区', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://s.baoyu.io/feed.xml', title: '宝玉的分享', category: 'AI（人工智能）', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://leovan.me/cn/index.xml', title: '范叶亮的博客', category: 'AI（人工智能）', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://kexue.fm/feed', title: '科学空间（苏剑林）', category: 'AI（人工智能）', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.leiphone.com/feed', title: '雷锋网', category: 'AI（人工智能）', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.qbitai.com/feed', title: '量子位', category: 'AI（人工智能）', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://a.jiemian.com/index.php?m=article&a=rss', title: '界面新闻 a.jiemian', category: '财经商业', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.tmtpost.com/feed', title: '钛媒体', category: '财经商业', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.ftchinese.com/rss/feed', title: 'FT 中文网', category: '财经商业', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://rss.dw.com/rdf/rss-chi-all', title: '德国之声中文', category: '新闻时事', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://theinitium.com/rss/', title: '端传媒', category: '新闻时事', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.rfi.fr/cn/rss', title: '法国国际广播电台', category: '新闻时事', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://cn.nytimes.com/rss/', title: '纽约时报中文网', category: '新闻时事', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.chinanews.com/rss/finance.xml', title: '中新网 财经', category: '新闻时事', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.chinanews.com/rss/world.xml', title: '中新网 国际', category: '新闻时事', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.chinanews.com/rss/society.xml', title: '中新网 社会', category: '新闻时事', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.chinanews.com/rss/china.xml', title: '中新网 时政', category: '新闻时事', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.chinanews.com/rss/culture.xml', title: '中新网 文化', category: '新闻时事', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://feeds.bbci.co.uk/zhongwen/trad/rss.xml', title: 'BBC 中文', category: '新闻时事', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.huanqiukexue.com/?feed=rss2', title: '环球科学（Scientific American 中文）', category: '科学学术', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.zhishifenzi.com/rss/', title: '知识分子', category: '科学学术', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.ifanr.com/feed', title: '爱范儿 ifanr', category: '产品设计与数字生活', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.gcores.com/rss', title: '机核 GCORES', category: '产品设计与数字生活', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.geekpark.net/rss', title: '极客公园', category: '产品设计与数字生活', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.toodaylab.com/feed', title: '理想生活实验室', category: '产品设计与数字生活', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.woshipm.com/feed', title: '人人都是产品经理', category: '产品设计与数字生活', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.appinn.com/feed/', title: '小众软件', category: '产品设计与数字生活', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://feed.iplaysoft.com/', title: '异次元软件', category: '产品设计与数字生活', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.changhai.org/feed.xml', title: '卢昌海', category: '独立个人博客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://changkun.de/blog/posts/index.xml', title: 'Changkun 的博客', category: '独立个人博客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://lutaonan.com/rss.xml', title: 'Randy\'s Blog', category: '独立个人博客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://pythonhunter.org/feed.xml', title: '捕蛇者说', category: '播客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://feed.xyzfm.space/ww7cqnybekty', title: '不合时宜', category: '播客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://buyiding.me/feed/podcast/', title: '不一定音乐广播', category: '播客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'http://rss.lizhi.fm/rss/14275.xml', title: '大内密谈', category: '播客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://feed.xyzfm.space/nfm8cu8deycn', title: '代码之外 Beyond Code', category: '播客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://feed.xyzfm.space/eye-on-east-asia', title: '东亚观察局', category: '播客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://feeds.storyfm.cn/storyfm.xml', title: '故事FM', category: '播客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://feeds.fireside.fm/sv101/rss', title: '硅谷101', category: '播客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://feed.xyzfm.space/cv4bkgpuglwp', title: '忽左忽右', category: '播客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://alioss.gcores.com/feeds/apple_podcast_v1.xml', title: '机核游戏频道', category: '播客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://api.vistopia.com.cn/rss/program/403.xml', title: '蒋方舟·一寸', category: '播客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://api.vistopia.com.cn/rss/program/333.xml', title: '看理想时刻', category: '播客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://api.vistopia.com.cn/rss/program/13.xml', title: '看理想圆桌', category: '播客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://api.vistopia.com.cn/rss/program/116.xml', title: '没理想编辑部', category: '播客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://feed.xyzfm.space/6hpdgggtxpxb', title: '面基', category: '播客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'http://www.ximalaya.com/album/5574153.xml', title: '日谈公园', category: '播客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://feed.xyzfm.space/87x9n4x77fpy', title: '日谈物语', category: '播客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'http://www.ximalaya.com/album/46587439.xml', title: '商业就是这样', category: '播客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://feeds.fireside.fm/shengdongjixi/rss', title: '声东击西', category: '播客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.ximalaya.com/album/51076156.xml', title: '声动早咖啡', category: '播客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://feed.xyzfm.space/vmpr88xy7qqg', title: '温柔一刀', category: '播客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://blog.yitianshijie.net/feed/', title: '一天世界', category: '播客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://feed.xyzfm.space/jq7xytwpykrg', title: '一席', category: '播客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://feeds.fireside.fm/guiguzaozhidao/rss', title: 'What\'s Next 科技早知道', category: '播客', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.sastind.gov.cn/n10086167/n10086221/rss.xml', title: '国防科工局 政策法规', category: '政府机构与公共信息', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.stats.gov.cn/sj/sjjd/rss.xml', title: '国家统计局 数据解读', category: '政府机构与公共信息', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.stats.gov.cn/sj/zxfb/rss.xml', title: '国家统计局 最新发布', category: '政府机构与公共信息', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.douban.com/feed/review/music', title: '豆瓣 音乐', category: '文化 / 书 / 影 / 音', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.douban.com/feed/review/movie', title: '豆瓣 影评', category: '文化 / 书 / 影 / 音', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.douban.com/feed/review/book', title: '豆瓣 最受关注书评', category: '文化 / 书 / 影 / 音', addedAt: CURATED_SEED_ADDED_AT },
  { url: 'https://www.digforfire.net/?feed=rss2', title: '掘火档案', category: '文化 / 书 / 影 / 音', addedAt: CURATED_SEED_ADDED_AT },
]

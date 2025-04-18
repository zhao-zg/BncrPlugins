/**
 * @description 监听京东推广数据更新并自动推送
 * @team zzg
 * @author zzg
 * @version v1.1.0
 * @name jtt
 * @rule ^(京推推)$
 * @priority 1000
 * @admin true
 * @disable false
 * @public true
 * @cron *\/10 * * * *
 * @classification ["数据服务"]
 */

const API_BASE = 'http://japi.jingtuitui.com/api';
const Redis = require('ioredis');

/****************** 配置项 ******************/
const jsonSchema = BncrCreateSchema.object({
    enable: BncrCreateSchema.boolean().setTitle('启用').setDefault(false),
    redisHost: BncrCreateSchema.string().setTitle('Redis地址').setDefault('192.168.10.3'),
    redisPort: BncrCreateSchema.number().setTitle('Redis端口').setDefault(11301),
    redisDB: BncrCreateSchema.number().setTitle('Redis库').setDefault(0),
    redisPassword: BncrCreateSchema.string().setTitle('Redis密码').setDefault(''),
    appId: BncrCreateSchema.string().setTitle('京东联盟密钥').setDefault('2504151445435516'),
    appKey: BncrCreateSchema.string().setTitle('京东联盟应用标识').setDefault('4ba89051dd17740867719b3107757a3f'),
    unionId: BncrCreateSchema.string().setTitle('京东联盟ID').setDefault('2033040066'),
    goodsTypes: BncrCreateSchema.array(
        BncrCreateSchema.string()
            .setEnum(["bugGoods", "sift"])
            .setEnumNames(['漏洞单', '精选好货'])
            .setDefault("bugGoods")
    ).setTitle('商品类型配置'),
    receivers: BncrCreateSchema.array(
        BncrCreateSchema.object({
            enable: BncrCreateSchema.boolean().setTitle('启用').setDefault(true),
            id: BncrCreateSchema.string().setTitle('接收ID').setDefault(''),
            type: BncrCreateSchema.string()
                .setEnum(["userId", "groupId"])
                .setEnumNames(['个人', '群'])
                .setDefault("groupId"),
            platform: BncrCreateSchema.string().setTitle('推送平台').setDefault('')
        })
    ).setTitle('接收配置')
});

const ConfigDB = new BncrPluginConfig(jsonSchema);

/****************** 通用函数 ******************/
async function apiRequest(path, params = {}) {
    const url = new URL(API_BASE + path);
    Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    });
    
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`接口请求失败，状态码 ${res.status}`);
    
    const data = await res.json();
    if (data.return != 0) throw new Error(`接口返回错误：${data.return}`);
    
    return data.result;
}

async function processGoods(goods, config, redis) {
    const cacheKey = `zzg:jtt:${goods.type}:${goods.goods_link}`;
    
    // 检查缓存
    const cached = await redis.get(cacheKey);
    if (cached) {
        console.log(`[已处理] ${goods.goods_link}`);
        return false;
    }

    // 检查过期时间
    const now = Math.floor(Date.now() / 1000);
    const expireSeconds = Math.min(goods.get_end_time - now, 86400);
    if (expireSeconds <= 0) {
        console.log(`[已过期] ${goods.goods_link}`);
        return false;
    }

    // 生成推广链接
    const linkResult = await apiRequest('/get_goods_link', {
        appid: config.appId,
        appkey: config.appKey,
        unionid: config.unionId,
        gid: goods.goods_link,
    });
    msg_content = goods.link_content.replace("[商品推广链接]", linkResult.link);
    // 组装消息
    const message = `【京东${goods.type === 'bugGoods' ? '漏洞单' : '精选好货'}】\n` +
                    `${msg_content}`;

    // 执行推送
    for (const receiver of config.receivers) {
        if (!receiver.enable || !receiver.id || !receiver.platform) continue;
        
        try {
            await sysMethod.push({
                platform: receiver.platform,
                [receiver.type]: receiver.id,
                msg: message,
            });
            await sysMethod.push({
                platform: receiver.platform,
                [receiver.type]: receiver.id,
                path: goods.goods_img,
                type: 'image'
            });
            console.log(`✅ 推送成功 ${receiver.platform} ${receiver.type}:${receiver.id}`);
        } catch (e) {
            console.error(`❌ 推送失败 ${receiver.platform} ${receiver.type}:${receiver.id}`, e);
        }
    }

    // 设置缓存
    await redis.set(cacheKey, '1', 'EX', expireSeconds);
    return true;
}

/****************** 主逻辑 ******************/
module.exports = async s => {
    await ConfigDB.get();
    const config = ConfigDB.userConfig;
    // 配置校验
    if (!config || !Object.keys(config).length) return s.reply('请使用"修改无界配置"初始化插件');
    if (!config.enable) return sysMethod.startOutLogs('插件未启用');
    if (!config.appId || !config.appKey || !config.unionId) return s.reply('缺失必要参数');
    if (!Array.isArray(config.receivers) || config.receivers.length === 0) return s.reply('未配置接收者');
    console.info(config.goodsTypes);
    console.info("?????");
    const redis = new Redis({
        host: config.redisHost,
        port: config.redisPort,
        password: config.redisPassword,
        db: config.redisDB
    });

    try {
        
        for (const goodsType of config.goodsTypes) {
			pageIndex = 1;
			total_count = 1;
			const allGoods = [];
			do{
                
				const result = await apiRequest('/get_goods_list', {
					eliteId: goodsType,
					appid: config.appId,
					appkey: config.appKey,
					v: 'v2',
					pageIndex: pageIndex,
					pageSize: '10'
				});
				total_count = result.total_count;
                pageIndex = result.pageSize;
				if (result?.data?.length > 0) {
					allGoods.push(...result.data.map(item => ({ ...item, type: goodsType })));
				}
				if (allGoods.length === 0) return await s.reply('未获取到有效商品数据');

				// 随机选取一个商品处理
				const shuffledGoods = allGoods.sort(() => 0.5 - Math.random());
				flag = false
				for (const goods of shuffledGoods) {
					if (await processGoods(goods, config, redis)) {
						console.log(`✔ 成功处理商品 ${goods.goods_link}`);
						flag = true;
						break; // 每次执行只处理一个商品
					}
				}
				if(flag){
					break;
				}
			}while(++pageIndex < total_count)
        }

        
    } catch (e) {
        console.error('[主流程错误]', e.stack);
        await s.reply(`服务异常: ${e.message}`);
    } finally {
        redis.disconnect();
    }
};

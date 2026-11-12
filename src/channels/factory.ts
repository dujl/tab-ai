import { type ChannelConfig, secret } from '../config.js';
import { type Channel } from '../core/types.js';
import { LarkChannel } from './lark.js';
import { DingTalkChannel } from './dingtalk.js';
import { WechatChannel } from './wechat.js';
import { WecomChannel } from './wecom.js';
export function createChannel(
  config: ChannelConfig,
  resolveSecret = secret,
  dataDir?: string,
): Channel {
  return config.type === 'lark'
    ? new LarkChannel(config, resolveSecret, dataDir)
    : config.type === 'dingtalk'
      ? new DingTalkChannel(config, resolveSecret)
      : config.type === 'wechat'
        ? new WechatChannel(config, resolveSecret, dataDir)
        : new WecomChannel(config, resolveSecret, dataDir);
}

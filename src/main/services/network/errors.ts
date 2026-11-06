import { NetworkError } from './httpClient'

const CHINESE = /[㐀-鿿]/

/**
 * Maps a fetch failure to the actionable Chinese copy from spec §11.1.
 * The raw error message is only useful for local diagnostics; every value
 * returned here is safe to show to the user.
 */
export function userFacingNetworkError(error: unknown, sourceName: string): string {
  if (error instanceof NetworkError) {
    if (error.kind === 'http' && error.status) {
      if (error.status === 403) {
        return `《${sourceName}》拒绝访问（403），可能需要登录或更换书源`
      }
      if (error.status === 404) {
        return `《${sourceName}》页面不存在（404），书源可能已失效`
      }
      if (error.status === 429) {
        return `《${sourceName}》请求太频繁（429），请稍后再试`
      }
      if (error.status >= 500 && error.status < 600) {
        return `《${sourceName}》站点暂时不可用（${error.status}），请稍后再试`
      }
    }
    if (error.kind === 'timeout') {
      return `连接《${sourceName}》超时，请稍后重试或换个书源`
    }
    return CHINESE.test(error.message) ? error.message : `《${sourceName}》请求失败，请稍后重试`
  }
  const message = error instanceof Error ? error.message : ''
  return CHINESE.test(message) ? message : `《${sourceName}》请求失败，请稍后重试`
}

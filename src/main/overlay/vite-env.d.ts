/** Vite `?raw` 导入：主进程构建把遮罩页 CSS 作为字符串注入 */
declare module '*.css?raw' {
  const content: string
  export default content
}

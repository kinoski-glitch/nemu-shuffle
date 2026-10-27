import { defineConfig } from 'vite';

// GitHub Pages のサブパス(/<リポジトリ名>/)でも動くよう相対パスで出力する
export default defineConfig({
  base: './',
});

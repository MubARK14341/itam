import { forwardRef, type ImgHTMLAttributes } from 'react';
export type ImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  src: string | { src: string; width?: number; height?: number }; fill?: boolean;
  priority?: boolean; unoptimized?: boolean; quality?: number; placeholder?: string; blurDataURL?: string;
};
const Image = forwardRef<HTMLImageElement, ImageProps>(function Image({ src, fill, priority, unoptimized: _unoptimized, quality: _quality, placeholder: _placeholder, blurDataURL: _blurDataURL, style, ...props }, ref) {
  const resolved = typeof src === 'string' ? src : src.src;
  if (resolved.startsWith('//') || (!resolved.startsWith('/') && !resolved.startsWith('blob:') && !resolved.startsWith('data:'))) throw new Error('External demo images are forbidden');
  return <img {...props} ref={ref} src={resolved} loading={priority ? 'eager' : props.loading ?? 'lazy'} style={fill ? { position: 'absolute', inset: 0, height: '100%', width: '100%', ...style } : style} />;
});
export default Image;

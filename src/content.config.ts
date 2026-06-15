import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const pages = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "src/content/pages" }),
  schema: z.object({
    title: z.string(),
    blocks: z.array(z.discriminatedUnion('type', [
      z.object({
        type: z.literal('hero'),
        title: z.string(),
        subtitle: z.string().optional(),
        color: z.string().optional(),
      }),
      z.object({
        type: z.literal('about'),
        title: z.string(),
        text: z.string(),
        image: z.string(),
        imageSide: z.enum(['left', 'right']).optional(),
      }),
      z.object({
        type: z.literal('events'),
        title: z.string(),
        color: z.string().optional(),
        events: z.array(z.object({
          id: z.string(),
          title: z.string(),
          subtitle: z.string().optional(),
          date: z.string(),
          time: z.string().optional(),
          location: z.string().optional(),
          description: z.string().optional(),
          flyerImage: z.string(),
          gallery: z.array(z.object({
            src: z.string(),
            alt: z.string().optional(),
          })).optional(),
          videos: z.array(z.object({
            title: z.string().optional(),
            videoUrl: z.string(),
          })).optional(),
        })).optional(),
      }),
      z.object({
        type: z.literal('team-grid'),
        title: z.string().optional(),
      }),
      z.object({
        type: z.literal('google-form'),
        url: z.string(),
        height: z.string().optional(),
      }),
      z.object({
        type: z.literal('text'),
        heading: z.string().optional(),
        text: z.string().optional(),
        alignment: z.enum(['left', 'center', 'right']).optional(),
      }),
      z.object({
        type: z.literal('youtube'),
        title: z.string().optional(),
        videoUrl: z.string().optional(),
      }),
      z.object({
        type: z.literal('gallery'),
        title: z.string().optional(),
        images: z.array(z.object({
          src: z.string(),
          alt: z.string().optional(),
        })).optional(),
      }),
    ])),
  }),
});

const team = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "src/content/team" }),
  schema: z.object({
    name: z.string(),
    role: z.string(),
    photo: z.string().optional(),
    order: z.number().optional(),
  }),
});

export const collections = { team, pages };

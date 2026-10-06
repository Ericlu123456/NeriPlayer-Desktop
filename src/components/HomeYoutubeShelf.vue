<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { HomeFeedItem, HomeFeedShelf } from '@/stores/recommend'
import BilibiliCoverImage from '@/components/BilibiliCoverImage.vue'

defineProps<{ shelf: HomeFeedShelf }>()
defineEmits<{ open: [item: HomeFeedItem]; more: [] }>()
const { t } = useI18n()
</script>

<template>
  <section class="youtube-shelf">
    <div class="shelf-header">
      <h2 class="shelf-title"><span class="youtube-icon" />{{ shelf.title || 'YouTube Music' }}</h2>
      <button class="shelf-more" @click="$emit('more')">{{ t('home.more') }}<span class="material-symbols-rounded">arrow_forward</span></button>
    </div>
    <div class="shelf-grid">
      <button v-for="(item, index) in shelf.items.slice(0, 6)" :key="(item.browseId || item.videoId || item.title) + '-' + index" type="button" class="shelf-card" @click="$emit('open', item)">
        <div class="shelf-cover">
          <span class="material-symbols-rounded filled">music_note</span>
          <BilibiliCoverImage v-if="item.coverUrl" :src="item.coverUrl" :alt="item.title" />
        </div>
        <div class="shelf-name">{{ item.title }}</div>
        <div class="shelf-subtitle">{{ item.subtitle }}</div>
      </button>
    </div>
  </section>
</template>

<style scoped lang="scss">
.youtube-shelf { margin-bottom: 32px; }
.shelf-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.shelf-title { display: flex; align-items: center; gap: 8px; font-size: 20px; font-weight: 650; min-width: 0; }
.youtube-icon { flex-shrink: 0; width: 23px; height: 23px; background: #ff0033; mask: url('/icons/ic_youtube.svg') center / contain no-repeat; }
.shelf-more { display: flex; align-items: center; gap: 4px; padding: 6px 12px; border-radius: var(--radius-full); color: var(--md-primary); font-size: 13px; flex-shrink: 0; }
.shelf-more:hover { background: color-mix(in srgb, var(--md-primary) 8%, transparent); }
.shelf-more .material-symbols-rounded { font-size: 18px; }
.shelf-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 20px; }
.shelf-card { min-width: 0; text-align: left; border-radius: var(--radius-md); }
.shelf-card:focus-visible { outline: 2px solid var(--md-primary); outline-offset: 3px; }
.shelf-cover { position: relative; display: grid; place-items: center; aspect-ratio: 1; overflow: hidden; border-radius: var(--radius-md); background: var(--md-surface-variant); transition: transform var(--duration-short); }
.shelf-cover > .material-symbols-rounded { font-size: 32px; opacity: 0.4; }
.shelf-cover img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.shelf-card:hover .shelf-cover { transform: translateY(-2px); }
.shelf-name { font-size: 14px; font-weight: 550; margin-top: 10px; }
.shelf-subtitle { font-size: 12px; color: var(--md-on-surface-variant); margin-top: 3px; }
.shelf-name, .shelf-subtitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 1000px) { .shelf-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; } .shelf-card:nth-child(n+5) { display: none; } }
@media (max-width: 700px) { .shelf-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; } .shelf-card:nth-child(n+4) { display: none; } }
@media (max-width: 480px) { .shelf-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .shelf-card:nth-child(n+3) { display: none; } .shelf-title { font-size: 18px; } }
@media (prefers-reduced-motion: reduce) { .shelf-cover { transition: none; } }
</style>

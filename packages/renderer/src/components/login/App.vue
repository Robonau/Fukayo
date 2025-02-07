<script lang="ts" setup>
import type { LoginAuth } from '@api/client/types';
import icon from '@assets/icon.svg';
import type { appLangsType } from '@i18n/index';
import type en from '@i18n/../locales/en.json';
import { useStore as useSettingsStore } from '@renderer/store/settings';
import { useQuasar } from 'quasar';
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';

/** quasar */
const $q = useQuasar();
const $t = useI18n<{message: typeof en}, appLangsType>().t.bind(useI18n());
/** stored settings */
const settings = useSettingsStore();
/** emit */
const emit = defineEmits<{ (event: 'done', auth: LoginAuth): void }>();


/** props */
defineProps({
  /** display a bad password error */
  badPassword: {
    type: Boolean,
    default: false,
  },
});


/** user password */
const password = ref<string|null>(null);
/** show a loading while connecting to the server */
const loading = ref(false);
/** toggler to display the password */
const showPassword = ref(false);

/** check the user inputed a login and password */
function readyToStart() {
  return settings.server.login && password.value;
}

/** connect to the server by sending an event to the parent component */
function connect() {
  if(!password.value || !settings.server.login) return;
  loading.value = true;
  emit('done', { login: settings.server.login, password: password.value });
}
</script>

<template>
  <div
    class="row q-pa-lg"
  >
    <q-card
      :dark="$q.dark.isActive"
      bordered
      class="q-pa-lg w-100"
      :class="$q.dark.isActive ? 'bg-dark' : 'bg-grey-3'"
    >
      <q-card-section
        horizontal
        class="items-center justify-center"
      >
        <q-avatar class="q-mr-md">
          <img
            :src="icon"
          >
        </q-avatar>
        <div class="text-h6">
          {{ $t('app.name') }}
          <div class="text-body2 text-grey-7">
            {{ $t('app.description') }}
          </div>
        </div>
      </q-card-section>
      <q-separator
        dark
        color="grey-9"
        inset
        class="justify-center q-mt-md"
      />
      <q-card-section>
        <q-form
          class="q-gutter-md"
          @submit="connect"
        >
          <q-input
            v-model="settings.server.login"
            filled
            dense
            bottoms-slots
            type="text"
            :dark="$q.dark.isActive"
            :label="$t('setup.login')"
          />
          <q-input
            v-model="password"
            filled
            dense
            bottom-slots
            :dark="$q.dark.isActive"
            :type="showPassword ? 'text' : 'password'"
            :label="$t('setup.password')"
          >
            <template #prepend>
              <q-icon
                :name="showPassword ? 'visibility' : 'visibility_off'"
                style="cursor:pointer;"
                @click="showPassword = !showPassword"
              />
            </template>
          </q-input>

          <div class="fit row wrap justify-end items-center content-center">
            <q-banner
              v-if="badPassword"
              inline-actions
              class="text-white bg-negative"
              :dark="$q.dark.isActive"
            >
              {{ $t('setup.badpassword') }}
              <template #action>
                <q-btn
                  flat
                  color="white"
                  :label="$t('setup.retry')"
                  :disabled="!readyToStart()"
                  type="submit"
                />
              </template>
            </q-banner>
            <q-btn
              v-else
              size="xl"
              round
              :loading="loading"
              :color="!readyToStart() ? 'warning' : 'negative'"
              :disabled="!readyToStart()"
              icon="local_fire_department"
              type="submit"
            />
          </div>
        </q-form>
      </q-card-section>
    </q-card>
  </div>
</template>

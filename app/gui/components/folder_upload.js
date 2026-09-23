export default {
  template: `
    <div class="nicegui-folder-upload">
      <q-btn-dropdown
        :label="label"
        icon="upload_file"
        color="primary"
        :disable="disable || uploading"
        class="full-width"
        :loading="uploading"
      >
        <q-list dense style="min-width: 16rem">
          <q-item clickable v-close-popup @click="selectFiles">
            <q-item-section avatar><q-icon name="attach_file" /></q-item-section>
            <q-item-section>
              <q-item-label>Choose files or ZIP</q-item-label>
              <q-item-label caption>One file, multiple files, or a project ZIP archive</q-item-label>
            </q-item-section>
          </q-item>
          <q-separator />
          <q-item clickable v-close-popup @click="selectFolder">
            <q-item-section avatar><q-icon name="folder_open" /></q-item-section>
            <q-item-section>
              <q-item-label>Choose project folder</q-item-label>
              <q-item-label caption>All supported files inside the selected folder</q-item-label>
            </q-item-section>
          </q-item>
        </q-list>
      </q-btn-dropdown>
      <input ref="filesInput" type="file" multiple :accept="accept" style="display:none" @change="uploadFiles" />
      <input ref="folderInput" type="file" webkitdirectory directory multiple :accept="accept" style="display:none" @change="uploadFiles" />
    </div>
  `,
  props: {
    url: String,
    label: String,
    accept: String,
    disable: Boolean,
    max_file_size: Number,
    max_total_size: Number,
    max_files: Number,
  },
  data() {
    return { computed_url: this.url, uploading: false };
  },
  mounted() {
    this.computeUrl();
  },
  updated() {
    this.computeUrl();
  },
  methods: {
    computeUrl() {
      this.computed_url = this.url && this.url.startsWith('/') ? window.path_prefix + this.url : this.url;
    },
    selectFolder() {
      if (!this.disable && !this.uploading) this.$refs.folderInput.click();
    },
    selectFiles() {
      if (!this.disable && !this.uploading) this.$refs.filesInput.click();
    },
    reject(message) {
      this.$q.notify({ type: 'negative', message });
    },
    finishUpload(success) {
      if (!this.uploading) return;
      this.uploading = false;
      if (!success) this.reject('Evidence upload failed. Please try again.');
    },
    uploadFiles(event) {
      const files = Array.from(event.target.files || []);
      event.target.value = '';
      if (!files.length) return;
      const total = files.reduce((sum, file) => sum + file.size, 0);
      if (this.max_files && files.length > this.max_files) {
        this.reject(`Folder contains more than ${this.max_files.toLocaleString()} files.`); return;
      }
      if (this.max_file_size && files.some(file => file.size > this.max_file_size)) {
        this.reject('One or more files exceed the configured upload size limit.'); return;
      }
      if (this.max_total_size && total > this.max_total_size) {
        this.reject('Folder exceeds the configured total upload size limit.'); return;
      }
      const data = new FormData();
      files.forEach(file => data.append(file.webkitRelativePath || file.name, file, file.name));
      const request = new XMLHttpRequest();
      this.uploading = true;
      request.open('POST', this.computed_url, true);
      request.onreadystatechange = () => {
        if (request.readyState !== XMLHttpRequest.DONE) return;
        this.finishUpload(request.status >= 200 && request.status < 300);
      };
      request.onerror = () => this.finishUpload(false);
      request.send(data);
    },
  },
};

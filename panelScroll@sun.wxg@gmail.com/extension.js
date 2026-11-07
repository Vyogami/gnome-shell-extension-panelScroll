// -*- mode: js2; indent-tabs-mode: nil; js2-basic-offset: 4 -*-
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import GLib from 'gi://GLib';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as WorkspaceSwitcherPopup from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';

const SCHEMA_NAME = 'org.gnome.shell.extensions.panelScroll';
const KEY_LEFT = 'left';
const KEY_RIGHT = 'right';
const KEY_PRIMARY = 'primary';
const KEY_WRAP_AROUND = 'wrap';
const KEY_DEBOUNCE = 'debounce';

const POSITION = {
    LEFT: 0,
    RIGHT: 1
};

class PanelScroll {
    constructor(settings) {
        this._allMonitor = false;
        this._time = 0;

        this.settings = settings;
        this.left = this.settings.get_string(KEY_LEFT);
        this.leftID = this.settings.connect("changed::" + KEY_LEFT, () => {
            this.left = this.settings.get_string(KEY_LEFT);
        });
        this.right = this.settings.get_string(KEY_RIGHT);
        this.rightID = this.settings.connect("changed::" + KEY_RIGHT, () => {
            this.right = this.settings.get_string(KEY_RIGHT);
        });
        this.primary = this.settings.get_boolean(KEY_PRIMARY);
        this.primaryID = this.settings.connect("changed::" + KEY_PRIMARY, () => {
            this.primary = this.settings.get_boolean(KEY_PRIMARY);
        });
        this.wrapAround = this.settings.get_boolean(KEY_WRAP_AROUND);
        this.wrapAroundID = this.settings.connect("changed::" + KEY_WRAP_AROUND, () => {
            this.wrapAround = this.settings.get_boolean(KEY_WRAP_AROUND);
        });
        this.debounce = this.settings.get_int(KEY_DEBOUNCE);
        this.debounceID = this.settings.connect("changed::" + KEY_DEBOUNCE, () => {
            this.debounce = this.settings.get_int(KEY_DEBOUNCE);
        });

        this.wm = global.workspace_manager;

        this.previousDirection = Meta.MotionDirection.UP;
        this.listPointer = 0;

        this._connectedPanels = new Map();
        this._scanTimeoutIds = [];

        this._scanPanels();

        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._scheduleScanPanels();
        });

        if (Main.extensionManager) {
            this._extensionStateChangedId = Main.extensionManager.connect('extension-state-changed', () => {
                this._scheduleScanPanels();
            });
        }

        if (Main.uiGroup) {
            try {
                this._uiGroupActorAddedId = Main.uiGroup.connect('child-added', (_group, actor) => {
                    if (actor && (actor.name === 'panelBox' || actor.name === 'panel')) {
                        this._scheduleScanPanels();
                    }
                });
            } catch (e) {
                try {
                    this._uiGroupActorAddedId = Main.uiGroup.connect('actor-added', (_group, actor) => {
                        if (actor && (actor.name === 'panelBox' || actor.name === 'panel')) {
                            this._scheduleScanPanels();
                        }
                    });
                } catch (e2) {
                    this._uiGroupActorAddedId = null;
                }
            }
        }
    }

    _scheduleScanPanels() {
        this._scanPanels();
        for (const delay of [100, 500, 1500]) {
            const tid = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this._scanPanels();
                const idx = this._scanTimeoutIds.indexOf(tid);
                if (idx >= 0)
                    this._scanTimeoutIds.splice(idx, 1);
                return GLib.SOURCE_REMOVE;
            });
            this._scanTimeoutIds.push(tid);
        }
    }

    _connectPanel(panel) {
        if (!panel || this._connectedPanels.has(panel))
            return;

        try {
            const scrollId = panel.connect('scroll-event', (actor, event) => {
                return this.scrollEvent(actor, event);
            });
            const destroyId = panel.connect('destroy', () => {
                console.log(`[panelScroll] Panel destroyed (monitorIndex=${panel.monitorIndex ?? 'primary'})`);
                this._disconnectPanel(panel);
            });
            this._connectedPanels.set(panel, { scrollId, destroyId });
            console.log(`[panelScroll] Connected to panel (monitorIndex=${panel.monitorIndex ?? 'primary'}, total connected: ${this._connectedPanels.size})`);
        } catch (e) {
            console.error(`[panelScroll] Failed to connect panel: ${e}`);
        }
    }

    _disconnectPanel(panel) {
        if (!this._connectedPanels.has(panel))
            return;

        const { scrollId, destroyId } = this._connectedPanels.get(panel);
        try {
            if (scrollId)
                panel.disconnect(scrollId);
        } catch (e) {}
        try {
            if (destroyId)
                panel.disconnect(destroyId);
        } catch (e) {}
        this._connectedPanels.delete(panel);
    }

    _disconnectAllPanels() {
        for (const [panel, { scrollId, destroyId }] of this._connectedPanels.entries()) {
            try {
                if (scrollId)
                    panel.disconnect(scrollId);
            } catch (e) {}
            try {
                if (destroyId)
                    panel.disconnect(destroyId);
            } catch (e) {}
        }
        this._connectedPanels.clear();
    }

    _scanPanels() {
        // 1. Primary panel
        if (Main.panel) {
            this._connectPanel(Main.panel);
        }

        // 2. Secondary panels from mmPanel
        const mmPanels = globalThis.mmPanel || Main.layoutManager?.mmPanel;
        if (Array.isArray(mmPanels)) {
            for (const panel of mmPanels) {
                if (panel)
                    this._connectPanel(panel);
            }
        }

        // 3. Scan Main.uiGroup for secondary panels/panelBoxes
        try {
            if (Main.uiGroup) {
                const children = Main.uiGroup.get_children();
                for (const child of children) {
                    if (!child)
                        continue;
                    if (child.name === 'panelBox' && child !== Main.layoutManager.panelBox) {
                        const subChildren = child.get_children ? child.get_children() : [];
                        for (const p of subChildren) {
                            if (p && (p.name === 'panel' || p.has_style_class_name?.('multimonitor-panel'))) {
                                this._connectPanel(p);
                            }
                        }
                    } else if (child.name === 'panel' && child !== Main.panel) {
                        this._connectPanel(child);
                    }
                }
            }
        } catch (e) {}
    }

    scrollEvent(actor, event) {
        let direction;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.LEFT:
            direction = Meta.MotionDirection.UP;
            break;
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.RIGHT:
            direction = Meta.MotionDirection.DOWN;
            break;
        default:
            return Clutter.EVENT_STOP;
        }

        let gap = event.get_time() - this._time;
        if (gap < this.debounce && gap >= 0) {
            console.log(`[panelScroll] Scroll debounced (gap=${gap}ms < debounce=${this.debounce}ms)`);
            return Clutter.EVENT_STOP;
        }
        this._time = event.get_time();

        const position = this.pointerOnPanel(actor);
        console.log(`[panelScroll] Scroll event triggered: direction=${direction}, pos=${position === POSITION.LEFT ? 'LEFT' : 'RIGHT'}, actor=${actor?.name ?? 'panel'}`);

        switch (position) {
        case POSITION.LEFT:
            if (this.left == 'window')
                this.switchWindows(direction);
            else
                this.switchWorkspace(direction, actor);
            break;
        case POSITION.RIGHT:
            if (this.right == 'window')
                this.switchWindows(direction);
            else
                this.switchWorkspace(direction, actor);
            break;
        }

        return Clutter.EVENT_STOP;
    }

    pointerOnPanel(actor) {
        let [x, y] = global.get_pointer();

        let currentMonitor = null;

        if (actor && typeof actor.monitorIndex === 'number' && Main.layoutManager.monitors[actor.monitorIndex]) {
            currentMonitor = Main.layoutManager.monitors[actor.monitorIndex];
        } else if (actor === Main.panel) {
            currentMonitor = Main.layoutManager.monitors[Main.layoutManager.primaryIndex] || Main.layoutManager.primaryMonitor;
        }

        if (!currentMonitor && Main.layoutManager.monitors) {
            for (const m of Main.layoutManager.monitors) {
                if (x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height) {
                    currentMonitor = m;
                    break;
                }
            }
        }

        if (!currentMonitor) {
            let currentMonitorIndex = global.display.get_current_monitor();
            currentMonitor = global.display.get_monitor_geometry(currentMonitorIndex);
        }

        if (!currentMonitor)
            return null;

        if (x < (currentMonitor.x + currentMonitor.width / 2))
            return POSITION.LEFT;

        let rightMargin = 0;
        try {
            let targetPanel = actor || Main.panel;
            let lastChild = targetPanel._rightBox?.get_last_child();
            let firstChild = lastChild?.get_first_child ? lastChild.get_first_child() : lastChild;
            if (firstChild && typeof firstChild.width === 'number' && firstChild.width > 0) {
                rightMargin = firstChild.width;
            } else if (Main.panel._rightBox) {
                let mainLast = Main.panel._rightBox.get_last_child();
                let mainFirst = mainLast?.get_first_child ? mainLast.get_first_child() : mainLast;
                if (mainFirst && typeof mainFirst.width === 'number' && mainFirst.width > 0)
                    rightMargin = mainFirst.width;
            }
        } catch (e) {
            rightMargin = 0;
        }

        if (x < (currentMonitor.x + currentMonitor.width - rightMargin))
            return POSITION.RIGHT;

        return null;
    }

    switchWindows(direction) {
        let windows = this.getWindows();
        if (windows.length <= 1)
            return;

        if (direction != this.previousDirection) {
            this.listPointer = 1;
        } else {
            this.listPointer += 1;
            if (this.listPointer > windows.length - 1)
                this.listPointer = windows.length -1;
        }
        this.previousDirection = direction;
        windows[this.listPointer].activate(global.get_current_time());
    }

    _getMonitorIndexForActor(actor) {
        if (actor && typeof actor.monitorIndex === 'number' && Main.layoutManager.monitors[actor.monitorIndex]) {
            return actor.monitorIndex;
        }
        if (actor === Main.panel) {
            return Main.layoutManager.primaryIndex;
        }
        let [x, y] = global.get_pointer();
        if (Main.layoutManager.monitors) {
            for (let i = 0; i < Main.layoutManager.monitors.length; i++) {
                let m = Main.layoutManager.monitors[i];
                if (x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height) {
                    return i;
                }
            }
        }
        return Main.layoutManager.primaryIndex;
    }

    switchWorkspace(direction, actor) {
        let monitorIndex = this._getMonitorIndexForActor(actor);
        console.log(`[panelScroll] switchWorkspace: direction=${direction}, actor=${actor?.name ?? 'unknown'}, monitor=${monitorIndex} (primary=${Main.layoutManager.primaryIndex})`);

        if (monitorIndex !== Main.layoutManager.primaryIndex) {
            try {
                let islandsExt = Main.extensionManager?.lookup?.('workspace-islands@danielbernalo.github.io');
                if (islandsExt && islandsExt.stateObj) {
                    console.log(`[panelScroll] Delegating to workspace-islands on monitor ${monitorIndex}`);
                    let delta = (direction === Meta.MotionDirection.UP || direction === Meta.MotionDirection.LEFT) ? -1 : 1;
                    if (typeof islandsExt.stateObj.switchMonitorWorkspace === 'function') {
                        if (islandsExt.stateObj.switchMonitorWorkspace(monitorIndex, delta, this.wrapAround)) {
                            console.log(`[panelScroll] workspace-islands switchMonitorWorkspace handled successfully`);
                            return;
                        }
                    } else if (islandsExt.stateObj._registry) {
                        let state = islandsExt.stateObj._registry.forMonitorIndex(monitorIndex);
                        if (state) {
                            let count = state.size;
                            let to = this.wrapAround
                                ? (state.activeIndex + delta + count) % count
                                : Math.min(Math.max(state.activeIndex + delta, 0), count - 1);
                            console.log(`[panelScroll] workspace-islands fallback switch: from=${state.activeIndex} to=${to}`);
                            if (to !== state.activeIndex) {
                                islandsExt.stateObj._requestSwitch(state, to, delta > 0);
                            }
                            return;
                        }
                    }
                } else {
                    console.warn(`[panelScroll] workspace-islands not found or inactive on secondary monitor switch`);
                }
            } catch (err) {
                console.error(`[panelScroll] workspace-islands integration error: ${err}`);
            }
        }

        let ws = this.getWorkSpace();

        let activeIndex = this.wm.get_active_workspace_index();

        let newWs;
        if (direction == Meta.MotionDirection.UP) {
            if (activeIndex == 0 ) {
                if (this.wrapAround)
                    newWs = ws.length - 1;
                else
                    newWs = activeIndex;
            } else
                newWs = activeIndex - 1;
        } else {
            if (activeIndex == (ws.length - 1) ) {
                if (this.wrapAround)
                    newWs = 0;
                else
                    newWs = activeIndex;
            } else
                newWs = activeIndex + 1;
        }

        console.log(`[panelScroll] Switching Mutter workspace: ${activeIndex} -> ${newWs}`);
        this.actionMoveWorkspace(ws[newWs]);
        this.switcherPopup(direction, ws[newWs]);
    }

    switcherPopup(direction, newWs) {
        if (!Main.overview.visible) {
            if (this._workspaceSwitcherPopup == null) {
                Main.wm._workspaceTracker.blockUpdates();
                this._workspaceSwitcherPopup = new WorkspaceSwitcherPopup.WorkspaceSwitcherPopup();
                this._workspaceSwitcherPopup.connect('destroy', () => {
                    Main.wm._workspaceTracker.unblockUpdates();
                    this._workspaceSwitcherPopup = null;
                });
            }
            this._workspaceSwitcherPopup.display(newWs.index());
        }
    }

    getWorkSpace() {
        let activeWs = this.wm.get_active_workspace();

        let activeIndex = activeWs.index();
        let ws = [];

        ws[activeIndex] = activeWs;

        const vertical = this.wm.layout_rows === -1;
        for (let i = activeIndex - 1; i >= 0; i--) {
            if (vertical)
                ws[i] = ws[i + 1].get_neighbor(Meta.MotionDirection.UP);
            else
                ws[i] = ws[i + 1].get_neighbor(Meta.MotionDirection.LEFT);
        }

        for (let i = activeIndex + 1; i < this.wm.n_workspaces; i++) {
            if (vertical)
                ws[i] = ws[i - 1].get_neighbor(Meta.MotionDirection.DOWN);
            else
                ws[i] = ws[i - 1].get_neighbor(Meta.MotionDirection.RIGHT);
        }

        return ws;
    }

    actionMoveWorkspace(workspace) {
        if (!Main.sessionMode.hasWorkspaces)
            return;

        let activeWorkspace = this.wm.get_active_workspace();

        if (activeWorkspace != workspace)
            workspace.activate(global.get_current_time());
    }

    getWindows() {
        let currentWorkspace = this.wm.get_active_workspace();

        let windows = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, currentWorkspace);
        windows.map(w => {
            return w.is_attached_dialog() ? w.get_transient_for() : w;
        }).filter((w, i, a) => !w.skip_taskbar && a.indexOf(w) == i);

        if (this.primary)
            return windows.filter((w) => w.is_on_primary_monitor() );
        else
            return windows;
    }

    destroy() {
        for (const tid of this._scanTimeoutIds) {
            GLib.source_remove(tid);
        }
        this._scanTimeoutIds = [];

        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }

        if (this._extensionStateChangedId && Main.extensionManager) {
            Main.extensionManager.disconnect(this._extensionStateChangedId);
            this._extensionStateChangedId = null;
        }

        if (this._uiGroupActorAddedId && Main.uiGroup) {
            Main.uiGroup.disconnect(this._uiGroupActorAddedId);
            this._uiGroupActorAddedId = null;
        }

        this._disconnectAllPanels();

        if (this.leftID)
            this.settings.disconnect(this.leftID);
        if (this.rightID)
            this.settings.disconnect(this.rightID);
        if (this.primaryID)
            this.settings.disconnect(this.primaryID);
        if (this.wrapAroundID)
            this.settings.disconnect(this.wrapAroundID);
        if (this.debounceID)
            this.settings.disconnect(this.debounceID);
    }
}

export default class PanelScrollExtension extends Extension {

    enable() {
        this._settings = this.getSettings();
        this.panelScroll = new PanelScroll(this._settings);
    }

    disable() {
        this.panelScroll.destroy();
        this._settings = null;
        this.panelScroll = null;
    }
}

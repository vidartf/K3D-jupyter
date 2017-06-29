'use strict';

var widgets = require('@jupyter-widgets/controls'),
    _ = require('lodash'),
    // pako = require('pako'),
    K3D = require('./core/Core'),
    serialize = require('./core/lib/helpers/serialize'),
    ThreeJsProvider = require('./providers/threejs/provider'),
    getScreenshot = require('./core/lib/screenshot').getScreenshot,
    buffer = require('./core/lib/helpers/buffer'),
    PlotModel,
    PlotView,
    ObjectModel,
    semverRange = '~' + require('../package.json').version,
    objectsList = {},
    plotsList = [];

require('es6-promise');

ObjectModel = widgets.WidgetModel.extend({
    defaults: _.extend(_.result({}, 'widgets.WidgetModel.prototype.defaults'), {
        _model_name: 'ObjectModel',
        _model_module: 'k3d',
        _view_module: 'k3d',
        _model_module_version: semverRange,
        _view_module_version: semverRange
    }),

    initialize: function () {
        var obj = arguments[0];

        widgets.WidgetModel.prototype.initialize.apply(this, arguments);

        this.on('change', this._change, this);
        this.on('msg:custom', function (obj) {
            if (obj.msg_type === 'fetch') {
                this.save(obj.field, this.get(obj.field));
            }
        }, this);

        objectsList[obj.id] = this;
    },

    _change: function () {
        plotsList.forEach(function (plot) {
            plot.refreshObject(this);
        }, this);
    }
}, {
    serializers: _.extend({
        model_matrix: serialize.array_or_json,
        point_positions: serialize.array_or_json,
        positions: serialize.array_or_json,
        point_colors: serialize.array_or_json,
        colors: serialize.array_or_json,
        scalar_field: serialize.array_or_json,
        color_map: serialize.array_or_json,
        attribute: serialize.array_or_json,
        vertices: serialize.array_or_json,
        indices: serialize.array_or_json,
        colors: serialize.array_or_json,
        origins: serialize.array_or_json,
        vectors: serialize.array_or_json,
        heights: serialize.array_or_json,
        voxels: serialize.array_or_json
    }, widgets.WidgetModel.serializers)
});

PlotModel = widgets.DOMWidgetModel.extend({
    defaults: _.extend(_.result({}, 'widgets.DOMWidgetModel.prototype.defaults'), {
        _model_name: 'PlotModel',
        _view_name: 'PlotView',
        _model_module: 'k3d',
        _view_module: 'k3d',
        _model_module_version: semverRange,
        _view_module_version: semverRange
    })
});

// Custom View. Renders the widget model.
PlotView = widgets.DOMWidgetView.extend({
    render: function () {
        var container = $('<div />').css('position', 'relative');

        this.container = container.css({'height': this.model.get('height')}).appendTo(this.$el).get(0);
        this.on('displayed', this._init, this);

        plotsList.push(this);

        this.model.on('msg:custom', function (obj) {
            var model = this.model;

            if (obj.msg_type === 'fetch_screenshot') {
                getScreenshot(this.K3DInstance).then(function (canvas) {
                    var data = canvas.toDataURL().split(',')[1];

                    // todo
                    //model.save('screenshot', buffer.base64ToArrayBuffer(data));
                    model.save('screenshot', data);
                });
            }
        }, this);
        this.model.on('change:camera_auto_fit', this._setCameraAutoFit, this);
        this.model.on('change:grid_auto_fit', this._setGridAutoFit, this);
        this.model.on('change:voxel_paint_color', this._setVoxelPaintColor, this);
        this.model.on('change:background_color', this._setBackgroundColor, this);
        this.model.on('change:grid', this._setGrid, this);
        this.model.on('change:camera', this._setCamera, this);
        this.model.on('change:object_ids', this._onObjectsListChange, this);
    },

    remove: function () {
        _.pull(plotsList, this);
        this.K3DInstance.off(this.K3DInstance.events.CAMERA_CHANGE, this.cameraChangeId);
    },

    _init: function () {
        var self = this;

        try {
            this.K3DInstance = new K3D(ThreeJsProvider, this.container, {
                antialias: this.model.get('antialias')
            });
        } catch (e) {
            return;
        }

        this.objectsChangesQueue = [];
        this.objectsChangesQueueRun = false;

        this.K3DInstance.setClearColor(this.model.get('background_color'));

        this._setCameraAutoFit();
        this._setGridAutoFit();
        this._setVoxelPaintColor();

        this.model.get('object_ids').forEach(function (id) {
            this.objectsChangesQueue.push({id: id, operation: 'insert'});
        }, this);

        if (this.objectsChangesQueue.length > 0) {
            this.startRefreshing();
        }

        this.cameraChangeId = this.K3DInstance.on(this.K3DInstance.events.CAMERA_CHANGE, function (control) {
            self.model.set('camera', control);
            self.model.save_changes();
        });
    },

    _setCameraAutoFit: function () {
        this.K3DInstance.setCameraAutoFit(this.model.get('camera_auto_fit'));
    },

    _setGridAutoFit: function () {
        this.K3DInstance.setGridAutoFit(this.model.get('grid_auto_fit'));
    },

    _setVoxelPaintColor: function () {
        this.K3DInstance.parameters.voxelPaintColor = this.model.get('voxel_paint_color');
    },

    _setBackgroundColor: function () {
        this.K3DInstance.setClearColor(this.model.get('background_color'));
    },

    _setGrid: function () {
        this.K3DInstance.setGrid(this.model.get('grid'));
    },

    _setCamera: function () {
        this.K3DInstance.setCamera(this.model.get('camera'));
    },

    _processObjectsChangesQueue: function (self) {
        var obj;

        if (self.objectsChangesQueue.length === 0) {
            return;
        }

        obj = self.objectsChangesQueue.shift();

        if (obj.operation === 'delete') {
            self.K3DInstance.removeObject(obj.id);
        }

        if (obj.operation === 'insert') {
            self.K3DInstance.load({objects: [objectsList[obj.id].attributes]});
        }

        if (obj.operation === 'update') {
            self.K3DInstance.reload(objectsList[obj.id].attributes);
        }

        if (self.objectsChangesQueue.length > 0) {
            setTimeout(self._processObjectsChangesQueue, 0, self);
        } else {
            self.objectsChangesQueueRun = false;
        }
    },

    _onObjectsListChange: function () {
        var old_object_ids = this.model.previous('object_ids'),
            new_object_ids = this.model.get('object_ids');

        _.difference(old_object_ids, new_object_ids).forEach(function (id) {
            this.objectsChangesQueue.push({id: id, operation: 'delete'});
        }, this);

        _.difference(new_object_ids, old_object_ids).forEach(function (id) {
            this.objectsChangesQueue.push({id: id, operation: 'insert'});
        }, this);

        this.startRefreshing();
    },

    refreshObject: function (obj) {
        if (this.model.get('object_ids').indexOf(obj.get('id')) !== -1) {
            this.objectsChangesQueue.push({id: obj.get('id'), operation: 'update'});
            this.startRefreshing();
        }
    },

    startRefreshing: function () {
        // force setTimeout to avoid freeze on browser in case of heavy load
        if (!this.objectsChangesQueueRun) {
            this.objectsChangesQueueRun = true;
            setTimeout(this._processObjectsChangesQueue, 0, this);
        }
    }
});

module.exports = {
    PlotModel: PlotModel,
    PlotView: PlotView,
    ObjectModel: ObjectModel,
};

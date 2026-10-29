const mongoose = require('mongoose');

const attendanceLogSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  date: {
    type: Date,
    default: Date.now
  },
  status: {
    type: String,
    default: 'confirmed',
    trim: true
  }
});

module.exports = mongoose.model('AttendanceLog', attendanceLogSchema);


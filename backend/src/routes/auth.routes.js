const router = require('express').Router();
const { body } = require('express-validator');
const AuthController = require('../controllers/auth.controller');
const { protect } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const loginRules = [
  body('email').isEmail().withMessage('Valid email required'),
  body('password').notEmpty().withMessage('Password required'),
];
const registerRules = [
  body('username').trim().isLength({ min: 3 }).withMessage('Username must be at least 3 characters'),
  body('email').isEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('role').optional().isIn(['admin','doctor','receptionist','patient']).withMessage('Invalid role'),
];

router.post('/register', registerRules, validate, AuthController.register);
router.post('/login',    loginRules,    validate, AuthController.login);
router.post('/refresh',  AuthController.refresh);
router.get('/me',        protect,       AuthController.me);
router.post('/logout',   protect,       AuthController.logout);

module.exports = router;
